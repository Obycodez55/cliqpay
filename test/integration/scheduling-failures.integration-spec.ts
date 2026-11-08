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
} from './support/scheduling-test-context';
import { dataOf, errorOf } from './support/api-response';
import { waitFor } from './support/social-blocks-test-helpers';
import { SCHEDULED_PAYMENT_RUNS_QUEUE } from '../../src/modules/scheduling/internal/queues';
import {
  addDays,
  lagosToday,
} from '../../src/modules/scheduling/internal/run-time';
import { ScheduledPaymentAttempt } from '../../src/modules/scheduling/entities/scheduled-payment-attempt.entity';
import { ScheduledPaymentChange } from '../../src/modules/scheduling/entities/scheduled-payment-change.entity';
import { ScheduledPaymentRun } from '../../src/modules/scheduling/entities/scheduled-payment-run.entity';

jest.setTimeout(180_000);

const HOUR_MS = 3_600_000;

describe('Scheduled payment failures, retries and pausing', () => {
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

  const hoursAfter = (from: Date, hours: number) =>
    new Date(from.getTime() + hours * HOUR_MS);

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

  const daily = { interval: { unit: 'day', count: 1 } };

  // A run row as the sweep leaves it for a one-time schedule, with no job.
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

  // Makes the schedule due and runs a real sweep with the queue muted, so
  // the run exists but nothing executes it until the test says so.
  async function claimRun(scheduleId: string): Promise<ScheduledPaymentRun> {
    await h.makeDue(scheduleId);
    const addBulk = jest
      .spyOn(queue(), 'addBulk')
      .mockResolvedValue([] as never);
    try {
      await h.engine().sweep();
    } finally {
      addBulk.mockRestore();
    }
    const runs = await h.runsOf(scheduleId);
    return runs[runs.length - 1];
  }

  const execute = (runId: string) => h.engine().executeRun(runId);

  // The first attempt of a run lands at 23:30 Lagos on its date, so a
  // transient failure has no retry left in the day and ends the run.
  async function executeAtNightfall(run: ScheduledPaymentRun) {
    await atClock(lagosAt(lagosToday(run.dueAt), '23:30'), () =>
      execute(run.id),
    );
    return h.runRepo().findOneByOrFail({ id: run.id });
  }

  const reload = (runId: string) => h.runRepo().findOneByOrFail({ id: runId });

  const attemptsOf = (runId: string) =>
    ctx.dataSource
      .getRepository(ScheduledPaymentAttempt)
      .find({ where: { runId }, order: { attemptNumber: 'ASC' } });

  const changesOf = (scheduleId: string) =>
    ctx.dataSource.getRepository(ScheduledPaymentChange).find({
      where: { scheduledPaymentId: scheduleId },
      order: { createdAt: 'ASC' },
    });

  const notificationsOf = (user: ScheduleUser, type: string) =>
    ctx.notificationRepo.findBy({ userId: user.userId, type });

  const topUp = (user: ScheduleUser, amount: bigint) =>
    fundWallet(ctx, {
      reference: `topup-${randomUUID()}`,
      walletId: user.walletId,
      netAmountMinor: amount,
    });

  const view = async (user: ScheduleUser, scheduleId: string) =>
    dataOf<ScheduleBody>(
      await h.getSchedule(user.userId, scheduleId).expect(200),
    );

  async function blockSender(sender: ScheduleUser, recipient: ScheduleUser) {
    await h
      .http()
      .put(`/social/blocks/${sender.userId}`)
      .set('Authorization', `Bearer ${h.tokenFor(recipient.userId)}`)
      .expect(200);
  }

  describe('retries', () => {
    it('retries at +2h, +4h and +6h within the day, then fails the run and tells the sender once', async () => {
      const { sender, schedule } = await seedSchedule({
        balanceMinor: 50_000n,
      });
      const date = addDays(lagosToday(new Date()), 10);
      const run = await insertRun(schedule.id, lagosAt(date, '06:00'));
      const first = lagosAt(date, '08:00');

      await atClock(first, () => execute(run.id));
      expect(await reload(run.id)).toMatchObject({
        status: 'pending',
        attemptCount: 1,
        nextAttemptAt: hoursAfter(first, 2),
      });

      await atClock(hoursAfter(first, 1), () => execute(run.id));
      expect(await attemptsOf(run.id)).toHaveLength(1);

      await atClock(hoursAfter(first, 2), () => execute(run.id));
      expect((await reload(run.id)).nextAttemptAt).toEqual(
        hoursAfter(first, 4),
      );
      await atClock(hoursAfter(first, 4), () => execute(run.id));
      expect((await reload(run.id)).nextAttemptAt).toEqual(
        hoursAfter(first, 6),
      );
      await h.waitForQueuesDrained();
      expect(
        await notificationsOf(sender, 'scheduled_payment_run_failed'),
      ).toHaveLength(0);

      await atClock(hoursAfter(first, 6), () => execute(run.id));

      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        attemptCount: 4,
        nextAttemptAt: null,
        transactionId: null,
      });
      const attempts = await attemptsOf(run.id);
      expect(
        attempts.map((a) => [a.attemptNumber, a.reference, a.failureCode]),
      ).toEqual(
        [1, 2, 3, 4].map((n) => [
          n,
          `sched_${schedule.id}_1_${n}`,
          'insufficient_balance',
        ]),
      );
      expect(attempts.every((a) => a.outcome === 'failed')).toBe(true);
      expect(
        await ctx.transactionRepo.countBy({
          reference: `sched_${schedule.id}_1_1`,
        }),
      ).toBe(0);

      await waitFor(
        async () =>
          (await notificationsOf(sender, 'scheduled_payment_run_failed'))
            .length === 1,
      );
      await h.waitForQueuesDrained();
      const [note] = await notificationsOf(
        sender,
        'scheduled_payment_run_failed',
      );
      expect(note.body).toContain('wallet balance was too low');
      expect(
        await notificationsOf(sender, 'scheduled_payment_run_failed'),
      ).toHaveLength(1);
      const row = await h.scheduleRepo().findOneByOrFail({ id: schedule.id });
      expect(row).toMatchObject({
        status: 'completed',
        consecutiveFailures: 1,
      });
    });

    it('succeeds on a later attempt under that attempt’s reference, and sends no failure notice', async () => {
      const { sender, recipient, schedule } = await seedSchedule({
        balanceMinor: 50_000n,
      });
      const date = addDays(lagosToday(new Date()), 10);
      const run = await insertRun(schedule.id, lagosAt(date, '06:00'));
      const first = lagosAt(date, '08:00');
      await atClock(first, () => execute(run.id));

      await topUp(sender, 5_000_000n);
      await atClock(hoursAfter(first, 2), () => execute(run.id));

      const posted = await ctx.transactionRepo.findOneByOrFail({
        reference: `sched_${schedule.id}_1_2`,
      });
      expect(await reload(run.id)).toMatchObject({
        status: 'succeeded',
        attemptCount: 2,
        nextAttemptAt: null,
        transactionId: posted.id,
      });
      const attempts = await attemptsOf(run.id);
      expect(
        attempts.map((a) => [a.attemptNumber, a.outcome, a.failureCode]),
      ).toEqual([
        [1, 'failed', 'insufficient_balance'],
        [2, 'succeeded', null],
      ]);
      expect(
        (await ctx.accountRepo.findOneByOrFail({ id: recipient.walletId }))
          .balance,
      ).toBe(100_000n);
      const row = await h.scheduleRepo().findOneByOrFail({ id: schedule.id });
      expect(row).toMatchObject({
        status: 'completed',
        consecutiveFailures: 0,
      });
      await h.waitForQueuesDrained();
      expect(
        await notificationsOf(sender, 'scheduled_payment_run_failed'),
      ).toHaveLength(0);
    });

    it('does not schedule an attempt that would fall after Lagos midnight of the run’s date', async () => {
      const { schedule } = await seedSchedule({ balanceMinor: 50_000n });
      const date = addDays(lagosToday(new Date()), 10);
      const run = await insertRun(schedule.id, lagosAt(date, '06:00'));

      // 21:30 + 2h = 23:30 fits; 23:30 + 2h would be 01:30 the next day.
      const first = lagosAt(date, '21:30');
      await atClock(first, () => execute(run.id));
      expect(await reload(run.id)).toMatchObject({
        status: 'pending',
        nextAttemptAt: hoursAfter(first, 2),
      });
      await atClock(hoursAfter(first, 2), () => execute(run.id));

      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        attemptCount: 2,
        nextAttemptAt: null,
      });
    });

    it('fails the run after one attempt when its first attempt is already within 2h of midnight', async () => {
      const { schedule } = await seedSchedule({ balanceMinor: 50_000n });
      const date = addDays(lagosToday(new Date()), 10);
      const run = await insertRun(schedule.id, lagosAt(date, '06:00'));

      await atClock(lagosAt(date, '22:30'), () => execute(run.id));

      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        attemptCount: 1,
      });
    });

    it.each([['daily_limit_exceeded'], ['recipient_cap']])(
      'treats %s as transient',
      async (code) => {
        const sender = await h.seedUser('sender', {
          kycTier: code === 'daily_limit_exceeded' ? 'tier1' : undefined,
          balanceMinor: 10_000_000n,
        });
        const recipient = await h.seedUser('recipient', {
          kycTier: code === 'recipient_cap' ? 'tier1' : undefined,
        });
        const schedule = dataOf<ScheduleBody>(
          await h
            .createSchedule(sender.userId, recipient.userId, {
              amount: code === 'daily_limit_exceeded' ? 3_000_000 : 100_000,
            })
            .expect(201),
        );
        if (code === 'daily_limit_exceeded') {
          await h
            .http()
            .post('/transfers')
            .set('Authorization', `Bearer ${h.tokenFor(sender.userId)}`)
            .send({
              recipientUserId: recipient.userId,
              amount: 3_000_000,
              reference: `live-${randomUUID()}`,
              visibility: 'private',
              pin: '1234',
            })
            .expect(201);
        } else {
          await topUp(recipient, 29_950_000n);
        }
        // The daily limit sums the Lagos day of the clock, so that case runs
        // today, alongside the transfer made above.
        const date =
          code === 'daily_limit_exceeded'
            ? lagosToday(new Date())
            : addDays(lagosToday(new Date()), 10);
        const run = await insertRun(schedule.id, lagosAt(date, '06:00'));

        await atClock(lagosAt(date, '08:00'), () => execute(run.id));

        expect((await attemptsOf(run.id))[0].failureCode).toBe(code);
        expect(await reload(run.id)).toMatchObject({
          status: 'pending',
          attemptCount: 1,
        });
      },
    );

    it('does not let stale-run recovery execute a retry before it is due', async () => {
      const { schedule } = await seedSchedule({ balanceMinor: 50_000n });
      const date = addDays(lagosToday(new Date()), 10);
      const run = await insertRun(schedule.id, lagosAt(date, '06:00'));
      await atClock(lagosAt(date, '08:00'), () => execute(run.id));
      // Old enough to look lost, but its next attempt is days away.
      await ctx.dataSource.query(
        `UPDATE scheduled_payment_runs SET created_at = now() - interval '1 hour' WHERE id = $1`,
        [run.id],
      );
      const addBulk = jest
        .spyOn(queue(), 'addBulk')
        .mockResolvedValue([] as never);
      const enqueuedForRun = () =>
        addBulk.mock.calls
          .flatMap(([jobs]) => jobs)
          .filter((job) => (job.data as { runId: string }).runId === run.id);

      await h.engine().sweep();
      expect(enqueuedForRun()).toHaveLength(0);

      await execute(run.id);
      expect(await attemptsOf(run.id)).toHaveLength(1);
      expect(
        await ctx.transactionRepo.countBy({
          reference: `sched_${schedule.id}_1_2`,
        }),
      ).toBe(0);

      await ctx.dataSource.query(
        `UPDATE scheduled_payment_runs SET next_attempt_at = now() - interval '1 minute' WHERE id = $1`,
        [run.id],
      );
      await h.engine().sweep();
      expect(enqueuedForRun().map((job) => job.opts?.jobId)).toEqual([
        `${schedule.id}_1_2`,
      ]);
    });
  });

  describe('pausing', () => {
    it('pauses at once on a permanent failure, with the failure code as the reason', async () => {
      const { sender, recipient, schedule } = await seedSchedule({
        body: daily,
      });
      await blockSender(sender, recipient);
      const run = await claimRun(schedule.id);

      await execute(run.id);

      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        attemptCount: 1,
      });
      expect((await attemptsOf(run.id))[0].failureCode).toBe('blocked');
      const row = await h.scheduleRepo().findOneByOrFail({ id: schedule.id });
      expect(row).toMatchObject({
        status: 'paused',
        pausedReason: 'blocked',
        consecutiveFailures: 1,
        nextRunAt: null,
      });
      const changes = await changesOf(schedule.id);
      expect(changes.map((c) => [c.kind, c.actor, c.reason])).toEqual([
        ['created', 'user', null],
        ['paused', 'system', 'blocked'],
      ]);
      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'paused',
        pausedReason: 'blocked',
        consecutiveFailures: 1,
        nextRunDate: null,
      });

      await waitFor(async () => {
        const failed = await notificationsOf(
          sender,
          'scheduled_payment_run_failed',
        );
        const paused = await notificationsOf(
          sender,
          'scheduled_payment_paused',
        );
        return failed.length === 1 && paused.length === 1;
      });
      const [paused] = await notificationsOf(
        sender,
        'scheduled_payment_paused',
      );
      expect(paused.data).toMatchObject({ reason: 'blocked' });
    });

    it('never sweeps a paused schedule', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      await h.pauseSchedule(sender.userId, schedule.id).expect(201);

      await claimRun(schedule.id);

      expect(await h.runsOf(schedule.id)).toHaveLength(0);
    });

    it('pauses after 3 failed runs in a row, and only a succeeded run resets the count', async () => {
      const { sender, schedule } = await seedSchedule({
        body: daily,
        balanceMinor: 50_000n,
      });
      const failOne = async () => {
        const run = await claimRun(schedule.id);
        expect((await executeAtNightfall(run)).status).toBe('failed');
      };
      const count = async () =>
        (await view(sender, schedule.id)).consecutiveFailures;

      await failOne();
      await failOne();
      expect(await count()).toBe(2);
      expect((await view(sender, schedule.id)).status).toBe('active');

      await topUp(sender, 50_000n);
      const good = await claimRun(schedule.id);
      await execute(good.id);
      expect((await reload(good.id)).status).toBe('succeeded');
      expect(await count()).toBe(0);

      await failOne();
      await failOne();
      expect(await count()).toBe(2);
      expect((await view(sender, schedule.id)).status).toBe('active');
      await failOne();

      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'paused',
        pausedReason: 'consecutive_failures',
        consecutiveFailures: 3,
        nextRunDate: null,
      });
      const changes = await changesOf(schedule.id);
      expect(changes.map((c) => [c.kind, c.actor, c.reason])).toEqual([
        ['created', 'user', null],
        ['paused', 'system', 'consecutive_failures'],
      ]);
      await waitFor(
        async () =>
          (await notificationsOf(sender, 'scheduled_payment_run_failed'))
            .length === 5 &&
          (await notificationsOf(sender, 'scheduled_payment_paused')).length ===
            1,
      );
    });

    it('completes rather than pauses a schedule that has no run left to start', async () => {
      const { sender, recipient, schedule } = await seedSchedule();
      await blockSender(sender, recipient);
      const run = await insertRun(schedule.id, new Date());

      await execute(run.id);

      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'completed',
        pausedReason: null,
        consecutiveFailures: 1,
      });
      await waitFor(
        async () =>
          (await notificationsOf(sender, 'scheduled_payment_run_failed'))
            .length === 1,
      );
      await h.waitForQueuesDrained();
      expect(
        await notificationsOf(sender, 'scheduled_payment_paused'),
      ).toHaveLength(0);
    });

    describe('by the user', () => {
      it('cancels pending runs, clears the next date, needs no PIN and sends nothing', async () => {
        const { sender, schedule } = await seedSchedule({
          body: daily,
          balanceMinor: 50_000n,
        });
        const run = await claimRun(schedule.id);
        await atClock(lagosAt(lagosToday(run.dueAt), '08:00'), () =>
          execute(run.id),
        );
        expect(await reload(run.id)).toMatchObject({
          status: 'pending',
          attemptCount: 1,
        });

        const res = await h
          .pauseSchedule(sender.userId, schedule.id)
          .expect(201);

        expect(dataOf<ScheduleBody>(res)).toMatchObject({
          status: 'paused',
          pausedReason: 'user',
          nextRunAt: null,
        });
        expect(await reload(run.id)).toMatchObject({
          status: 'cancelled',
          nextAttemptAt: null,
        });
        const changes = await changesOf(schedule.id);
        expect(changes.map((c) => [c.kind, c.actor, c.reason])).toEqual([
          ['created', 'user', null],
          ['paused', 'user', 'user'],
        ]);

        await execute(run.id);
        expect(await attemptsOf(run.id)).toHaveLength(1);
        await h.waitForQueuesDrained();
        expect(
          await notificationsOf(sender, 'scheduled_payment_paused'),
        ).toHaveLength(0);
        expect(
          await notificationsOf(sender, 'scheduled_payment_run_failed'),
        ).toHaveLength(0);
      });

      it('is idempotent, and refuses a schedule that has ended', async () => {
        const { sender, schedule } = await seedSchedule({ body: daily });
        await h.pauseSchedule(sender.userId, schedule.id).expect(201);
        await h.pauseSchedule(sender.userId, schedule.id).expect(201);
        expect(await changesOf(schedule.id)).toHaveLength(2);

        const other = await seedSchedule();
        await h
          .cancelSchedule(other.sender.userId, other.schedule.id)
          .expect(201);
        const res = await h
          .pauseSchedule(other.sender.userId, other.schedule.id)
          .expect(409);
        expect(errorOf(res).code).toBe('SCHEDULE_STATUS_CONFLICT');
      });

      it('is owner only', async () => {
        const { schedule } = await seedSchedule();
        const stranger = await h.seedUser('stranger');

        await h.pauseSchedule(stranger.userId, schedule.id).expect(404);
        await h.resumeSchedule(stranger.userId, schedule.id).expect(404);
      });

      it('lets an executing attempt finish: money that moved is recorded as succeeded', async () => {
        const { sender, schedule } = await seedSchedule({ body: daily });
        const run = await claimRun(schedule.id);
        const engine = h.engine() as unknown as {
          recordResult: (...args: unknown[]) => Promise<void>;
        };
        const original = engine.recordResult.bind(engine) as (
          ...args: unknown[]
        ) => Promise<void>;
        jest
          .spyOn(engine, 'recordResult')
          .mockImplementationOnce(async (...args: unknown[]) => {
            await h.pauseSchedule(sender.userId, schedule.id).expect(201);
            await original(...args);
          });

        await execute(run.id);

        expect(await reload(run.id)).toMatchObject({ status: 'succeeded' });
        expect(await view(sender, schedule.id)).toMatchObject({
          status: 'paused',
          pausedReason: 'user',
          consecutiveFailures: 0,
        });
      });
    });
  });

  describe('resume', () => {
    async function pausedByUser() {
      const seeded = await seedSchedule({ body: daily });
      await h
        .pauseSchedule(seeded.sender.userId, seeded.schedule.id)
        .expect(201);
      return seeded;
    }

    it('needs the PIN', async () => {
      const { sender, schedule } = await pausedByUser();

      await h.resumeSchedule(sender.userId, schedule.id, {}).expect(400);
      await h
        .resumeSchedule(sender.userId, schedule.id, { pin: '9999' })
        .expect(401);

      expect((await view(sender, schedule.id)).status).toBe('paused');
    });

    it('resumes at the next run date, resets the failure count and logs it', async () => {
      const { sender, recipient, schedule } = await seedSchedule({
        body: daily,
      });
      await blockSender(sender, recipient);
      await execute((await claimRun(schedule.id)).id);
      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'paused',
        consecutiveFailures: 1,
      });

      const res = await h
        .resumeSchedule(sender.userId, schedule.id)
        .expect(201);

      const body = dataOf<ScheduleBody>(res);
      expect(body).toMatchObject({
        status: 'active',
        pausedReason: null,
        consecutiveFailures: 0,
        runsUsed: 1,
        // Run 1 carried the start date (tomorrow), so run 2 is the day after.
        nextRunDate: addDays(lagosToday(new Date()), 2),
      });
      const row = await h.scheduleRepo().findOneByOrFail({ id: schedule.id });
      expect(row.nextRunNumber).toBe(2);
      expect(
        (await changesOf(schedule.id)).map((c) => [c.kind, c.actor]),
      ).toEqual([
        ['created', 'user'],
        ['paused', 'system'],
        ['resumed', 'user'],
      ]);
    });

    it('refuses a schedule that is not paused', async () => {
      const { sender, schedule } = await seedSchedule();

      const res = await h
        .resumeSchedule(sender.userId, schedule.id)
        .expect(409);

      expect(errorOf(res).code).toBe('SCHEDULE_STATUS_CONFLICT');
    });

    it('skips the dates that passed while paused and counts only the runs created toward max_runs', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, maxRuns: 3 },
      });
      await h.makeDue(schedule.id);
      await h.engine().sweep();
      await h.waitForRunEnd(schedule.id);
      await h.waitForQueuesDrained();
      await h.pauseSchedule(sender.userId, schedule.id).expect(201);
      // Ten days go by while it is paused.
      await ctx.dataSource.query(
        `UPDATE scheduled_payments SET start_date = start_date - 10 WHERE id = $1`,
        [schedule.id],
      );

      const resumed = dataOf<ScheduleBody>(
        await h.resumeSchedule(sender.userId, schedule.id).expect(201),
      );

      const row = await h.scheduleRepo().findOneByOrFail({ id: schedule.id });
      expect(row.nextRunNumber).toBeGreaterThan(5);
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
      expect(resumed.runsUsed).toBe(1);
      expect(await h.runsOf(schedule.id)).toHaveLength(1);

      const resumedAt = row.nextRunNumber;
      for (const expected of [2, 3]) {
        await h.makeDue(schedule.id);
        await h.engine().sweep();
        await waitFor(
          async () => (await h.runsOf(schedule.id)).length === expected,
        );
        await h.waitForRunEnd(schedule.id);
        await h.waitForQueuesDrained();
      }

      const runs = await h.runsOf(schedule.id);
      expect(runs.map((r) => r.runNumber)).toEqual([
        1,
        resumedAt,
        resumedAt + 1,
      ]);
      expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'completed',
        runsUsed: 3,
        nextRunDate: null,
      });
    });

    it('is rejected with a 422, leaving the schedule paused, when a one-time date has passed', async () => {
      const { sender, schedule } = await seedSchedule();
      await h.pauseSchedule(sender.userId, schedule.id).expect(201);
      await ctx.dataSource.query(
        `UPDATE scheduled_payments SET start_date = start_date - 5 WHERE id = $1`,
        [schedule.id],
      );

      const res = await h
        .resumeSchedule(sender.userId, schedule.id)
        .expect(422);

      expect(errorOf(res).code).toBe('SCHEDULE_NOTHING_TO_RESUME');
      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'paused',
        pausedReason: 'user',
      });
      await h.cancelSchedule(sender.userId, schedule.id).expect(201);
    });

    it('is rejected with a 422 when the end date has passed', async () => {
      const { sender, schedule } = await seedSchedule({
        body: { ...daily, endDate: addDays(lagosToday(new Date()), 5) },
      });
      await h.pauseSchedule(sender.userId, schedule.id).expect(201);
      await ctx.dataSource.query(
        `UPDATE scheduled_payments SET start_date = start_date - 10, end_date = end_date - 8 WHERE id = $1`,
        [schedule.id],
      );

      const res = await h
        .resumeSchedule(sender.userId, schedule.id)
        .expect(422);

      expect(errorOf(res).code).toBe('SCHEDULE_NOTHING_TO_RESUME');
      expect((await view(sender, schedule.id)).status).toBe('paused');
    });
  });

  describe('paused schedules and the list', () => {
    it('count toward the active-schedule limit, and the list filters on them', async () => {
      const original = ctx.config.scheduledPayments.maxActive;
      ctx.config.scheduledPayments.maxActive = 2;
      try {
        const sender = await h.seedUser('sender');
        const recipient = await h.seedUser('recipient');
        const first = dataOf<ScheduleBody>(
          await h.createSchedule(sender.userId, recipient.userId).expect(201),
        );
        await h.createSchedule(sender.userId, recipient.userId).expect(201);
        await h.pauseSchedule(sender.userId, first.id).expect(201);

        const res = await h
          .createSchedule(sender.userId, recipient.userId)
          .expect(422);
        expect(errorOf(res).code).toBe('SCHEDULE_LIMIT_REACHED');

        const paused = dataOf<{ items: ScheduleBody[] }>(
          await h.listSchedules(sender.userId, '?status=paused').expect(200),
        );
        expect(paused.items.map((s) => s.id)).toEqual([first.id]);
        const active = dataOf<{ items: ScheduleBody[] }>(
          await h.listSchedules(sender.userId, '?status=active').expect(200),
        );
        expect(active.items.map((s) => s.id)).not.toContain(first.id);
        expect(active.items).toHaveLength(1);
        expect(paused.items[0]).toMatchObject({
          pausedReason: 'user',
          consecutiveFailures: 0,
        });
      } finally {
        ctx.config.scheduledPayments.maxActive = original;
      }
    });
  });

  describe('GET /scheduled-payments/:id/runs', () => {
    interface RunBody {
      id: string;
      runNumber: number;
      dueDate: string;
      status: string;
      amount: { amount: string; currency: string };
      nextAttemptAt: string | null;
      transactionId: string | null;
      attempts: {
        attemptNumber: number;
        outcome: string;
        failureCode: string | null;
        transactionId: string | null;
        startedAt: string;
      }[];
    }
    const pageOf = (res: { body: unknown }) =>
      dataOf<{ items: RunBody[]; nextCursor: string | null }>(res);

    it('lists runs newest first with their attempts nested, in keyset pages', async () => {
      const { sender, schedule } = await seedSchedule({
        body: daily,
        balanceMinor: 50_000n,
      });
      const failed = await claimRun(schedule.id);
      await executeAtNightfall(failed);
      const retrying = await claimRun(schedule.id);
      await atClock(lagosAt(lagosToday(retrying.dueAt), '08:00'), () =>
        execute(retrying.id),
      );
      await topUp(sender, 5_000_000n);
      const good = await claimRun(schedule.id);
      await execute(good.id);

      const first = pageOf(
        await h.listRuns(sender.userId, schedule.id, '?limit=2').expect(200),
      );

      expect(first.items.map((r) => r.runNumber)).toEqual([3, 2]);
      expect(first.nextCursor).not.toBeNull();
      expect(first.items[0]).toMatchObject({
        id: good.id,
        status: 'succeeded',
        dueDate: lagosToday(good.dueAt),
        amount: { amount: '100000', currency: 'NGN' },
        nextAttemptAt: null,
      });
      expect(first.items[0].transactionId).not.toBeNull();
      expect(first.items[0].attempts).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          outcome: 'succeeded',
          failureCode: null,
          transactionId: first.items[0].transactionId,
        }),
      ]);
      expect(first.items[1]).toMatchObject({ status: 'pending' });
      expect(first.items[1].nextAttemptAt).not.toBeNull();
      expect(first.items[1].attempts).toHaveLength(1);

      const second = pageOf(
        await h
          .listRuns(
            sender.userId,
            schedule.id,
            `?limit=2&cursor=${first.nextCursor}`,
          )
          .expect(200),
      );
      expect(second.items.map((r) => r.runNumber)).toEqual([1]);
      expect(second.nextCursor).toBeNull();
      expect(second.items[0]).toMatchObject({ status: 'failed' });
      expect(second.items[0].attempts).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          outcome: 'failed',
          failureCode: 'insufficient_balance',
          transactionId: null,
        }),
      ]);
      expect(typeof second.items[0].attempts[0].startedAt).toBe('string');
    });

    it('is owner only, and rejects a forged cursor or a limit over 50', async () => {
      const { sender, schedule } = await seedSchedule();
      const stranger = await h.seedUser('stranger');

      await h.listRuns(stranger.userId, schedule.id).expect(404);
      await h.listRuns(sender.userId, randomUUID()).expect(404);
      await h
        .listRuns(sender.userId, schedule.id, '?cursor=garbage')
        .expect(400);
      await h.listRuns(sender.userId, schedule.id, '?limit=51').expect(400);
      const empty = pageOf(
        await h.listRuns(sender.userId, schedule.id).expect(200),
      );
      expect(empty).toEqual({ items: [], nextCursor: null });
    });
  });
});
