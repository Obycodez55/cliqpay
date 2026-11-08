import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  createSchedulingHelpers,
  createSchedulingTestContext,
} from './support/scheduling-test-context';
import { dataOf } from './support/api-response';
import { SCHEDULED_PAYMENT_RUNS_QUEUE } from '../../src/modules/scheduling/internal/queues';
import { ScheduledPayment } from '../../src/modules/scheduling/entities/scheduled-payment.entity';

jest.setTimeout(180_000);

describe('Scheduled payment sweep', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);
  let runsQueue: Queue;

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
    runsQueue = ctx.app.get<Queue>(getQueueToken(SCHEDULED_PAYMENT_RUNS_QUEUE));
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function seedSchedule(
    body: Record<string, unknown> = {},
    balanceMinor = 5_000_000n,
  ) {
    const sender = await h.seedUser('sender', { balanceMinor });
    const recipient = await h.seedUser('recipient');
    const schedule = dataOf<ScheduleBody>(
      await h.createSchedule(sender.userId, recipient.userId, body).expect(201),
    );
    return { sender, recipient, schedule };
  }

  it('turns a due schedule into one run snapshotting the schedule, and advances it', async () => {
    const { recipient, schedule } = await seedSchedule({
      amount: 120_000,
      note: 'Rent',
      visibility: 'public',
    });
    await h.makeDue(schedule.id);
    const dueAt = (await h.scheduleRepo().findOneByOrFail({ id: schedule.id }))
      .nextRunAt!;
    const addBulk = jest.spyOn(runsQueue, 'addBulk');

    await h.engine().sweep();

    const runs = await h.runsOf(schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runNumber: 1,
      status: 'pending',
      amount: 120_000n,
      targetType: 'user',
      recipientUserId: recipient.userId,
      note: 'Rent',
      visibility: 'public',
      attemptCount: 0,
    });
    expect(runs[0].dueAt).toEqual(dueAt);

    const advanced = await h
      .scheduleRepo()
      .findOneByOrFail({ id: schedule.id });
    expect(advanced.nextRunNumber).toBe(2);
    expect(advanced.nextRunAt).toBeNull();

    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        data: { runId: runs[0].id },
        opts: { jobId: `${schedule.id}_1` },
      }),
    ]);
  });

  it('ignores schedules that are not due, cancelled, or already swept', async () => {
    const future = await seedSchedule();
    const cancelled = await seedSchedule();
    await h.makeDue(cancelled.schedule.id);
    await h
      .cancelSchedule(cancelled.sender.userId, cancelled.schedule.id)
      .expect(201);
    const due = await seedSchedule();
    await h.makeDue(due.schedule.id);

    await h.engine().sweep();
    await h.engine().sweep();

    expect(await h.runsOf(future.schedule.id)).toHaveLength(0);
    expect(await h.runsOf(cancelled.schedule.id)).toHaveLength(0);
    expect(await h.runsOf(due.schedule.id)).toHaveLength(1);
  });

  it('creates each run exactly once when several sweepers claim at the same time', async () => {
    const seeded: Awaited<ReturnType<typeof seedSchedule>>[] = [];
    for (let i = 0; i < 6; i++) {
      seeded.push(await seedSchedule());
    }
    for (const { schedule } of seeded) {
      await h.makeDue(schedule.id);
    }
    const addBulk = jest.spyOn(runsQueue, 'addBulk');

    await Promise.all([
      h.engine().sweep(),
      h.engine().sweep(),
      h.engine().sweep(),
    ]);

    for (const { schedule } of seeded) {
      const runs = await h.runsOf(schedule.id);
      expect(runs).toHaveLength(1);
      const advanced = await h
        .scheduleRepo()
        .findOneByOrFail({ id: schedule.id });
      expect(advanced.nextRunNumber).toBe(2);
    }
    const enqueued = addBulk.mock.calls.flatMap(([jobs]) =>
      jobs.map((job) => job.opts?.jobId),
    );
    expect(enqueued.sort()).toEqual(
      seeded.map(({ schedule }) => `${schedule.id}_1`).sort(),
    );
    for (const { schedule } of seeded) {
      await h.waitForRunEnd(schedule.id);
    }
  });

  it('re-enqueues a pending run that lost its job once it is a few minutes old, and not before', async () => {
    const { schedule } = await seedSchedule();
    await h.makeDue(schedule.id);
    const addBulk = jest.spyOn(runsQueue, 'addBulk');
    addBulk.mockRejectedValueOnce(new Error('redis went away'));

    await h.engine().sweep();
    const [run] = await h.runsOf(schedule.id);
    expect(run.status).toBe('pending');

    await h.engine().sweep();
    expect(addBulk).toHaveBeenCalledTimes(1);

    await ctx.dataSource.query(
      `UPDATE scheduled_payment_runs SET created_at = now() - interval '10 minutes' WHERE id = $1`,
      [run.id],
    );
    await h.engine().sweep();

    expect(addBulk).toHaveBeenCalledTimes(2);
    const ended = await h.waitForRunEnd(schedule.id);
    expect(ended.status).toBe('succeeded');
  });

  it('is safe to enqueue a run twice: the second job id is a no-op and the run pays once', async () => {
    const { sender, schedule } = await seedSchedule({ amount: 100_000 });
    await h.makeDue(schedule.id);
    await h.engine().sweep();
    const [run] = await h.runsOf(schedule.id);
    await ctx.dataSource.query(
      `UPDATE scheduled_payment_runs SET created_at = now() - interval '10 minutes' WHERE id = $1`,
      [run.id],
    );
    await h.engine().sweep();
    await h.engine().sweep();
    await h.waitForRunEnd(schedule.id);
    await h.waitForQueuesDrained();

    const wallet = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });
    expect(wallet.balance).toBe(5_000_000n - 100_000n);
    expect(
      await ctx.transactionRepo.countBy({
        reference: `sched_${schedule.id}_1_1`,
      }),
    ).toBe(1);
  });

  it('leaves a schedule untouched while another transaction holds its row lock', async () => {
    const { schedule } = await seedSchedule();
    await h.makeDue(schedule.id);

    const runner = ctx.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.manager
      .getRepository(ScheduledPayment)
      .createQueryBuilder('s')
      .where('s.id = :id', { id: schedule.id })
      .setLock('pessimistic_write')
      .getOne();
    try {
      await h.engine().sweep();
      expect(await h.runsOf(schedule.id)).toHaveLength(0);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }

    await h.engine().sweep();
    expect(await h.runsOf(schedule.id)).toHaveLength(1);
    await h.waitForRunEnd(schedule.id);
  });
});
