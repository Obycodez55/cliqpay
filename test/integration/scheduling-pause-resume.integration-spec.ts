import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  atClock,
  createSchedulingTestContext,
  lagosAt,
} from './support/scheduling-test-context';
import { dataOf, errorOf } from './support/api-response';
import {
  ACCOUNT_SELF_LOCKED_EVENT,
  AccountSelfLockedEventPayload,
} from '../../src/shared/events/domain-events';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { waitFor } from './support/social-blocks-test-helpers';
import {
  addDays,
  lagosToday,
} from '../../src/modules/scheduling/internal/run-time';
import { createFailureHelpers } from './support/scheduling-failure-helpers';

jest.setTimeout(180_000);

describe('Scheduled payment pausing and resuming', () => {
  let ctx: TransfersTestContext;
  const {
    h,
    seedSchedule,
    daily,
    insertRun,
    claimRun,
    execute,
    executeAtNightfall,
    reload,
    attemptsOf,
    changesOf,
    notificationsOf,
    topUp,
    view,
    blockSender,
  } = createFailureHelpers(() => ctx);

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
        pausedReason: 'recipient_unable_to_receive',
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
      expect(paused.data).toMatchObject({
        reason: 'recipient_unable_to_receive',
      });
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

  describe('a schedule that stops while a run is waiting', () => {
    it('is cancelled along with its other pending runs by a system pause, and pays nothing', async () => {
      const { sender, recipient, schedule } = await seedSchedule({
        body: daily,
      });
      const first = await claimRun(schedule.id);
      const second = await claimRun(schedule.id);
      await blockSender(sender, recipient);

      await execute(first.id);

      expect(await reload(first.id)).toMatchObject({ status: 'failed' });
      expect(await reload(second.id)).toMatchObject({
        status: 'cancelled',
        nextAttemptAt: null,
      });
      await execute(second.id);
      expect(await reload(second.id).then((r) => r.status)).toBe('cancelled');
      expect(await attemptsOf(second.id)).toHaveLength(0);
      expect(
        await ctx.transactionRepo.countBy({
          reference: `sched_${schedule.id}_${second.runNumber}_1`,
        }),
      ).toBe(0);
    });

    it.each(['paused', 'cancelled'] as const)(
      'is not paid when the schedule is %s, and the run ends cancelled',
      async (status) => {
        const { sender, schedule } = await seedSchedule({ body: daily });
        const run = await claimRun(schedule.id);
        await h
          .scheduleRepo()
          .update({ id: schedule.id }, { status, nextRunAt: null });

        await execute(run.id);

        expect(await reload(run.id)).toMatchObject({
          status: 'cancelled',
          nextAttemptAt: null,
          attemptCount: 0,
        });
        expect(await attemptsOf(run.id)).toHaveLength(0);
        expect(
          await ctx.transactionRepo.countBy({
            reference: `sched_${schedule.id}_${run.runNumber}_1`,
          }),
        ).toBe(0);
        expect(
          (await ctx.accountRepo.findOneByOrFail({ id: sender.walletId }))
            .balance,
        ).toBe(5_000_000n);
      },
    );

    it('records an attempt once when two workers execute it together', async () => {
      const { schedule } = await seedSchedule({
        body: daily,
        balanceMinor: 50_000n,
      });
      const run = await claimRun(schedule.id);

      await atClock(lagosAt(lagosToday(run.dueAt), '23:30'), () =>
        Promise.all([execute(run.id), execute(run.id)]),
      );

      expect(await attemptsOf(run.id)).toHaveLength(1);
      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        attemptCount: 1,
      });
      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: schedule.id }))
          .consecutiveFailures,
      ).toBe(1);
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
  describe('when the owner locks the account', () => {
    const publishLock = (userId: string) =>
      ctx.app
        .get(EventBusService)
        .publish<string, AccountSelfLockedEventPayload>({
          name: ACCOUNT_SELF_LOCKED_EVENT,
          payload: {
            userId,
            email: 'owner@example.com',
            occurredAt: new Date().toISOString(),
          },
          occurredAt: new Date(),
        });

    it('pauses their active schedules as the system, cancels waiting runs and leaves other users alone, and resuming needs the normal resume', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      const run = await insertRun(
        schedule.id,
        new Date(Date.now() + 3_600_000),
      );
      const other = await seedSchedule({ body: daily });

      await publishLock(sender.userId);
      await waitFor(
        async () =>
          (await h.scheduleRepo().findOneByOrFail({ id: schedule.id }))
            .status === 'paused',
      );

      expect(
        await h.scheduleRepo().findOneByOrFail({ id: schedule.id }),
      ).toMatchObject({
        status: 'paused',
        pausedReason: 'account_locked',
        nextRunAt: null,
      });
      expect((await reload(run.id)).status).toBe('cancelled');
      expect(
        (await changesOf(schedule.id)).map((c) => [c.kind, c.actor, c.reason]),
      ).toEqual([
        ['created', 'user', null],
        ['paused', 'system', 'account_locked'],
      ]);
      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: other.schedule.id }))
          .status,
      ).toBe('active');

      await h.resumeSchedule(sender.userId, schedule.id, { pin: '0000' });
      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: schedule.id })).status,
      ).toBe('paused');
      await h.resumeSchedule(sender.userId, schedule.id).expect(201);
      expect(
        (await h.scheduleRepo().findOneByOrFail({ id: schedule.id })).status,
      ).toBe('active');
    });
  });
});
