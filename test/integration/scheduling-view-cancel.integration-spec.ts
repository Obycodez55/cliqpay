import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  createSchedulingHelpers,
  createSchedulingTestContext,
  tomorrow,
} from './support/scheduling-test-context';
import { dataOf, errorOf } from './support/api-response';
import { randomUUID } from 'crypto';
import { RunEngine } from '../../src/modules/scheduling/internal/run-engine.service';
import { ScheduledPaymentChange } from '../../src/modules/scheduling/entities/scheduled-payment-change.entity';
import { TransfersService } from '../../src/modules/transfers/transfers.service';

jest.setTimeout(180_000);

describe('Viewing and cancelling a scheduled payment', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function seedSchedule(body: Record<string, unknown> = {}) {
    const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
    const recipient = await h.seedUser('recipient');
    const schedule = dataOf<ScheduleBody>(
      await h.createSchedule(sender.userId, recipient.userId, body).expect(201),
    );
    return { sender, recipient, schedule };
  }

  const changesOf = (scheduleId: string) =>
    ctx.dataSource.getRepository(ScheduledPaymentChange).find({
      where: { scheduledPaymentId: scheduleId },
      order: { createdAt: 'ASC' },
    });

  async function insertPendingRun(scheduleId: string) {
    const schedule = await h.scheduleRepo().findOneByOrFail({ id: scheduleId });
    return h.runRepo().save(
      h.runRepo().create({
        scheduledPaymentId: schedule.id,
        runNumber: 1,
        dueAt: new Date(),
        status: 'pending',
        amount: schedule.amount,
        targetType: schedule.targetType,
        recipientUserId: schedule.recipientUserId,
        note: schedule.note,
        visibility: schedule.visibility,
      }),
    );
  }

  describe('GET /scheduled-payments/:id', () => {
    it('shows the owner their schedule', async () => {
      const { sender, recipient, schedule } = await seedSchedule({
        amount: 321_000,
        note: 'School fees',
        visibility: 'public',
        startDate: tomorrow(),
      });

      const body = dataOf<ScheduleBody>(
        await h.getSchedule(sender.userId, schedule.id).expect(200),
      );

      expect(body).toMatchObject({
        id: schedule.id,
        target: { type: 'user', userId: recipient.userId },
        amount: { amount: '321000', currency: 'NGN' },
        note: 'School fees',
        visibility: 'public',
        status: 'active',
        nextRunDate: tomorrow(),
        nextRunAt: schedule.nextRunAt,
      });
    });

    it('returns 404 to anyone else, and for an unknown id', async () => {
      const { recipient, schedule } = await seedSchedule();
      const stranger = await h.seedUser('stranger');

      for (const userId of [recipient.userId, stranger.userId]) {
        const res = await h.getSchedule(userId, schedule.id).expect(404);
        expect(errorOf(res).code).toBe('SCHEDULED_PAYMENT_NOT_FOUND');
      }
      await h.getSchedule(stranger.userId, randomUUID()).expect(404);
      await h.getSchedule(stranger.userId, 'not-a-uuid').expect(400);
    });
  });

  describe('POST /scheduled-payments/:id/cancel', () => {
    it('cancels without a PIN, with a cancelled change and no notification', async () => {
      const { sender, schedule } = await seedSchedule();
      await h.waitForQueuesDrained();
      const before = await ctx.notificationRepo.countBy({
        userId: sender.userId,
      });

      const res = await h.cancelSchedule(sender.userId, schedule.id);

      expect(res.status).toBe(201);
      expect(dataOf<ScheduleBody>(res)).toMatchObject({
        status: 'cancelled',
        nextRunAt: null,
        nextRunDate: null,
      });
      expect(
        (await changesOf(schedule.id)).map((c) => [c.kind, c.actor]),
      ).toEqual([
        ['created', 'user'],
        ['cancelled', 'user'],
      ]);
      await h.waitForQueuesDrained();
      expect(
        await ctx.notificationRepo.countBy({ userId: sender.userId }),
      ).toBe(before);
      expect(await h.runsOf(schedule.id)).toHaveLength(0);
    });

    it('cancels the schedule and its pending run in one step', async () => {
      const { sender, schedule } = await seedSchedule();
      const run = await insertPendingRun(schedule.id);

      await h.cancelSchedule(sender.userId, schedule.id).expect(201);

      expect((await h.runRepo().findOneByOrFail({ id: run.id })).status).toBe(
        'cancelled',
      );
      const attempts = await ctx.dataSource.query<{ count: string }[]>(
        `SELECT count(*) FROM scheduled_payment_attempts WHERE run_id = $1`,
        [run.id],
      );
      expect(attempts[0].count).toBe('0');
    });

    it('stops a swept run from paying when the cancel comes before the worker', async () => {
      const { sender, schedule } = await seedSchedule({ amount: 100_000 });
      const run = await insertPendingRun(schedule.id);
      await h.cancelSchedule(sender.userId, schedule.id).expect(201);

      await ctx.app.get(RunEngine, { strict: false }).executeRun(run.id);

      expect(
        await ctx.transactionRepo.countBy({
          reference: `sched_${schedule.id}_1_1`,
        }),
      ).toBe(0);
    });

    it('lets an attempt that is already executing finish', async () => {
      const { sender, schedule } = await seedSchedule({ amount: 100_000 });
      const run = await insertPendingRun(schedule.id);
      const transfers = ctx.app.get(TransfersService);
      const original = ((): TransfersService['executeScheduledTransfer'] =>
        // eslint-disable-next-line @typescript-eslint/unbound-method
        TransfersService.prototype.executeScheduledTransfer)();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const started = new Promise<void>((resolve) => (entered = resolve));
      jest
        .spyOn(transfers, 'executeScheduledTransfer')
        .mockImplementation((...args) => {
          entered();
          return gate.then(() => Reflect.apply(original, transfers, args));
        });

      const executing = ctx.app
        .get(RunEngine, { strict: false })
        .executeRun(run.id);
      await started;
      await h.cancelSchedule(sender.userId, schedule.id).expect(201);
      expect((await h.runRepo().findOneByOrFail({ id: run.id })).status).toBe(
        'cancelled',
      );
      release();
      await executing;

      const finished = await h.runRepo().findOneByOrFail({ id: run.id });
      expect(finished.status).toBe('succeeded');
      expect(finished.transactionId).not.toBeNull();
      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: schedule.id })).status,
      ).toBe('cancelled');
      expect((await changesOf(schedule.id)).map((c) => c.kind)).toEqual([
        'created',
        'cancelled',
      ]);
    });

    it('is idempotent', async () => {
      const { sender, schedule } = await seedSchedule();

      await h.cancelSchedule(sender.userId, schedule.id).expect(201);
      const again = await h.cancelSchedule(sender.userId, schedule.id);

      expect(again.status).toBe(201);
      expect(dataOf<ScheduleBody>(again).status).toBe('cancelled');
      expect(await changesOf(schedule.id)).toHaveLength(2);
    });

    it('returns 404 to anyone but the owner, leaving the schedule active', async () => {
      const { recipient, schedule } = await seedSchedule();

      await h.cancelSchedule(recipient.userId, schedule.id).expect(404);

      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: schedule.id })).status,
      ).toBe('active');
    });

    it('refuses to cancel a schedule that has already run', async () => {
      const { sender, schedule } = await seedSchedule({ amount: 100_000 });
      await h.makeDue(schedule.id);
      await h.engine().sweep();
      await h.waitForRunEnd(schedule.id);

      const res = await h
        .cancelSchedule(sender.userId, schedule.id)
        .expect(409);

      expect(errorOf(res).code).toBe('SCHEDULE_ALREADY_COMPLETED');
    });
  });
});
