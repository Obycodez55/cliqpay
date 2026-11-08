import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
  fundWallet,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  ScheduleUser,
  atClock,
  createSchedulingHelpers,
  createSchedulingTestContext,
  lagosAt,
  tomorrow,
} from './support/scheduling-test-context';
import { dataOf } from './support/api-response';
import { waitFor } from './support/social-blocks-test-helpers';
import { SCHEDULED_PAYMENT_RUNS_QUEUE } from '../../src/modules/scheduling/internal/queues';
import { addDays } from '../../src/modules/scheduling/internal/run-time';
import { ScheduledPaymentAttempt } from '../../src/modules/scheduling/entities/scheduled-payment-attempt.entity';

jest.setTimeout(180_000);

const MISSED = 'scheduled_payment_runs_missed';
const UPCOMING = 'scheduled_payment_upcoming';

describe('Missed scheduled runs and the low-balance reminder', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);
  const queue = () =>
    ctx.app.get<Queue>(getQueueToken(SCHEDULED_PAYMENT_RUNS_QUEUE));

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const day = tomorrow();
  const daily = { interval: { unit: 'day', count: 1 } };

  async function seedSchedule(
    options: { body?: Record<string, unknown>; balanceMinor?: bigint } = {},
  ) {
    const sender = await h.seedUser('sender', {
      balanceMinor: options.balanceMinor ?? 5_000_000n,
    });
    const recipient = await h.seedUser('recipient');
    const schedule = dataOf<ScheduleBody>(
      await h
        .createSchedule(sender.userId, recipient.userId, options.body)
        .expect(201),
    );
    return { sender, recipient, schedule };
  }

  // A sweep at a chosen moment with the queue muted, so nothing executes a
  // created run until the test says so.
  async function sweepAt(now: Date) {
    jest.spyOn(queue(), 'addBulk').mockResolvedValue([] as never);
    await atClock(now, () => h.engine().sweep());
    jest.restoreAllMocks();
  }

  async function insertRun(scheduleId: string, dueAt: Date) {
    await h.scheduleRepo().update({ id: scheduleId }, { nextRunAt: null });
    const schedule = await h.scheduleRepo().findOneByOrFail({ id: scheduleId });
    return h.runRepo().save(
      h.runRepo().create({
        scheduledPaymentId: schedule.id,
        runNumber: 1,
        dueAt,
        status: 'pending',
        amount: schedule.amount,
        targetType: schedule.targetType,
        recipientUserId: schedule.recipientUserId,
        note: schedule.note,
        visibility: schedule.visibility,
      }),
    );
  }

  const reload = (runId: string) => h.runRepo().findOneByOrFail({ id: runId });
  const attemptsOf = (runId: string) =>
    ctx.dataSource
      .getRepository(ScheduledPaymentAttempt)
      .find({ where: { runId }, order: { createdAt: 'ASC' } });
  const notificationsOf = (user: ScheduleUser, type: string) =>
    ctx.notificationRepo.findBy({ userId: user.userId, type });
  const scheduleOf = (id: string) => h.scheduleRepo().findOneByOrFail({ id });

  describe('catching up after downtime', () => {
    it('runs a run that is late but still on its day', async () => {
      const { schedule, recipient } = await seedSchedule();

      await sweepAt(lagosAt(day, '15:00'));
      const [run] = await h.runsOf(schedule.id);
      expect(run.status).toBe('pending');
      await atClock(lagosAt(day, '15:00'), () => h.engine().executeRun(run.id));

      expect(await reload(run.id)).toMatchObject({
        status: 'succeeded',
        attemptCount: 1,
      });
      expect(
        (await ctx.accountRepo.findOneByOrFail({ id: recipient.walletId }))
          .balance,
      ).toBe(100_000n);
      expect(await h.runsOf(schedule.id)).toHaveLength(1);
    });

    it('records every skipped date of a daily schedule as missed, and completes it on max_runs without pausing', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, maxRuns: 3 },
      });

      await sweepAt(lagosAt(addDays(day, 3), '10:00'));

      const runs = await h.runsOf(schedule.id);
      expect(runs.map((r) => r.status)).toEqual(['missed', 'missed', 'missed']);
      expect(runs.map((r) => r.runNumber)).toEqual([1, 2, 3]);
      for (const run of runs) {
        expect(run).toMatchObject({ attemptCount: 0, transactionId: null });
        const attempts = await attemptsOf(run.id);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          kind: 'missed',
          attemptNumber: null,
          reference: null,
          outcome: null,
          startedAt: null,
        });
      }
      expect(await scheduleOf(schedule.id)).toMatchObject({
        status: 'completed',
        nextRunAt: null,
        consecutiveFailures: 0,
        pausedReason: null,
      });
      expect(
        await ctx.transactionRepo
          .createQueryBuilder('t')
          .where('t.reference LIKE :ref', { ref: `sched_${schedule.id}_%` })
          .getCount(),
      ).toBe(0);

      await waitFor(
        async () => (await notificationsOf(sender, MISSED)).length === 1,
      );
      await h.waitForQueuesDrained();
      const notes = await notificationsOf(sender, MISSED);
      expect(notes).toHaveLength(1);
      for (const date of [day, addDays(day, 1), addDays(day, 2)]) {
        expect(notes[0].body).toContain(date);
      }

      const listed = dataOf<{
        items: {
          status: string;
          attempts: Record<string, unknown>[];
        }[];
      }>(await h.listRuns(sender.userId, schedule.id).expect(200));
      expect(listed.items.map((r) => r.status)).toEqual([
        'missed',
        'missed',
        'missed',
      ]);
      expect(listed.items[0].attempts).toEqual([
        {
          kind: 'missed',
          attemptNumber: null,
          outcome: null,
          failureCode: null,
          transactionId: null,
          startedAt: null,
        },
      ]);
    });

    it('still runs today’s run after the missed ones, and keeps the schedule going', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });

      await sweepAt(lagosAt(addDays(day, 3), '10:00'));

      const runs = await h.runsOf(schedule.id);
      expect(runs.map((r) => r.status)).toEqual([
        'missed',
        'missed',
        'missed',
        'pending',
      ]);
      const row = await scheduleOf(schedule.id);
      expect(row).toMatchObject({
        status: 'active',
        nextRunNumber: 5,
        consecutiveFailures: 0,
      });
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(
        lagosAt(addDays(day, 4), '00:00').getTime(),
      );
      await waitFor(
        async () => (await notificationsOf(sender, MISSED)).length === 1,
      );
      await h.cancelSchedule(sender.userId, schedule.id).expect(201);
    });

    it('records a first attempt whose day ended before it could execute as missed, never paid', async () => {
      const { sender, recipient, schedule } = await seedSchedule();
      const run = await insertRun(schedule.id, lagosAt(day, '06:00'));

      await atClock(lagosAt(addDays(day, 1), '00:30'), () =>
        h.engine().executeRun(run.id),
      );

      expect(await reload(run.id)).toMatchObject({
        status: 'missed',
        attemptCount: 0,
        transactionId: null,
      });
      const attempts = await attemptsOf(run.id);
      expect(attempts.map((a) => [a.kind, a.reference])).toEqual([
        ['missed', null],
      ]);
      expect(
        (await ctx.accountRepo.findOneByOrFail({ id: recipient.walletId }))
          .balance,
      ).toBe(0n);
      expect(await scheduleOf(schedule.id)).toMatchObject({
        status: 'completed',
        consecutiveFailures: 0,
      });
      await waitFor(
        async () => (await notificationsOf(sender, MISSED)).length === 1,
      );
    });

    it('fails a retry that fell due after its day ended, keeping the last failure code and counting it', async () => {
      const { sender, recipient, schedule } = await seedSchedule({
        balanceMinor: 50_000n,
      });
      const run = await insertRun(schedule.id, lagosAt(day, '06:00'));
      await atClock(lagosAt(day, '08:00'), () => h.engine().executeRun(run.id));
      expect(await reload(run.id)).toMatchObject({
        status: 'pending',
        attemptCount: 1,
      });
      await fundWallet(ctx, {
        reference: `topup-${randomUUID()}`,
        walletId: sender.walletId,
        netAmountMinor: 5_000_000n,
      });

      await atClock(lagosAt(addDays(day, 1), '00:30'), () =>
        h.engine().executeRun(run.id),
      );

      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        attemptCount: 1,
        nextAttemptAt: null,
        transactionId: null,
      });
      expect(await attemptsOf(run.id)).toHaveLength(1);
      expect(
        (await ctx.accountRepo.findOneByOrFail({ id: recipient.walletId }))
          .balance,
      ).toBe(0n);
      expect(await scheduleOf(schedule.id)).toMatchObject({
        consecutiveFailures: 1,
        status: 'completed',
      });
      await waitFor(
        async () =>
          (await notificationsOf(sender, 'scheduled_payment_run_failed'))
            .length === 1,
      );
      const [note] = await notificationsOf(
        sender,
        'scheduled_payment_run_failed',
      );
      expect(note.body).toContain('wallet balance was too low');
    });

    it('requires the attempt columns on an attempt row', async () => {
      const { schedule } = await seedSchedule();
      const run = await insertRun(schedule.id, lagosAt(day, '06:00'));
      await expect(
        ctx.dataSource.query(
          `INSERT INTO scheduled_payment_attempts (run_id, kind) VALUES ($1, 'attempt')`,
          [run.id],
        ),
      ).rejects.toThrow(/CHK_scheduled_payment_attempts_attempt_fields/);
    });
  });

  describe('low-balance reminder', () => {
    const eveningBefore = lagosAt(addDays(day, -1), '18:00');

    it('warns once when the balance is below the run amount, and not again on a re-run or a concurrent run', async () => {
      const { sender, schedule } = await seedSchedule({
        balanceMinor: 50_000n,
      });

      await h.engine().sendUpcomingReminders(eveningBefore);
      await Promise.all([
        h.engine().sendUpcomingReminders(eveningBefore),
        h.engine().sendUpcomingReminders(eveningBefore),
      ]);
      await h.engine().sendUpcomingReminders(eveningBefore);

      await waitFor(
        async () => (await notificationsOf(sender, UPCOMING)).length >= 1,
      );
      await h.waitForQueuesDrained();
      const notes = await notificationsOf(sender, UPCOMING);
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toContain(day);
      expect((await scheduleOf(schedule.id)).lastRemindedRunDate).toBe(day);
    });

    it('counts a transfer platform fee: warns at amount + fee − 1, not at amount + fee', async () => {
      ctx.config.transfers.platformFee = 5_000;
      try {
        const short = await seedSchedule({ balanceMinor: 104_999n });
        const covered = await seedSchedule({ balanceMinor: 105_000n });

        await h.engine().sendUpcomingReminders(eveningBefore);

        await waitFor(
          async () =>
            (await notificationsOf(short.sender, UPCOMING)).length === 1,
        );
        await h.waitForQueuesDrained();
        expect(await notificationsOf(covered.sender, UPCOMING)).toHaveLength(0);
        const [note] = await notificationsOf(short.sender, UPCOMING);
        expect(note.body).toContain('NGN 50.00 in fees');
      } finally {
        ctx.config.transfers.platformFee = 0;
      }
    });

    it('stays quiet when the balance covers the run, or the run is not tomorrow', async () => {
      const covered = await seedSchedule({ balanceMinor: 100_000n });
      const later = await seedSchedule({
        balanceMinor: 50_000n,
        body: { startDate: addDays(day, 1) },
      });

      await h.engine().sendUpcomingReminders(eveningBefore);
      await h.waitForQueuesDrained();

      expect(await notificationsOf(covered.sender, UPCOMING)).toHaveLength(0);
      expect(await notificationsOf(later.sender, UPCOMING)).toHaveLength(0);
      expect(
        (await scheduleOf(covered.schedule.id)).lastRemindedRunDate,
      ).toBeNull();
    });

    it('warns again for the next run of a recurring schedule', async () => {
      const { sender, schedule } = await seedSchedule({
        balanceMinor: 50_000n,
        body: daily,
      });

      await h.engine().sendUpcomingReminders(eveningBefore);
      await sweepAt(lagosAt(day, '10:00'));
      await h.engine().sendUpcomingReminders(lagosAt(day, '18:00'));

      await waitFor(
        async () => (await notificationsOf(sender, UPCOMING)).length === 2,
      );
      expect((await scheduleOf(schedule.id)).lastRemindedRunDate).toBe(
        addDays(day, 1),
      );
      await h.cancelSchedule(sender.userId, schedule.id).expect(201);
    });
  });
});
