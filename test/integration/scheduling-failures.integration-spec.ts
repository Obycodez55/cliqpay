import { randomUUID } from 'crypto';
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
import { dataOf } from './support/api-response';
import { waitFor } from './support/social-blocks-test-helpers';
import {
  addDays,
  lagosToday,
} from '../../src/modules/scheduling/internal/run-time';
import { createFailureHelpers } from './support/scheduling-failure-helpers';

jest.setTimeout(180_000);

describe('Scheduled payment failures and retries', () => {
  let ctx: TransfersTestContext;
  const {
    h,
    queue,
    hoursAfter,
    seedSchedule,
    daily,
    insertRun,
    claimRun,
    execute,
    executeAtNightfall,
    reload,
    attemptsOf,
    notificationsOf,
    topUp,
    view,
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

  describe('failures that are not about the recipient', () => {
    const setMinimum = (key: 'transfers' | 'withdrawals', value: number) => {
      (ctx.config[key] as { minAmount: number }).minAmount = value;
    };

    it('amount_below_minimum: a minimum raised above the amount is permanent and pauses', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      const run = await claimRun(schedule.id);
      setMinimum('transfers', 200_000);
      try {
        await execute(run.id);
      } finally {
        setMinimum('transfers', 10_000);
      }

      expect((await attemptsOf(run.id))[0].failureCode).toBe(
        'amount_below_minimum',
      );
      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        attemptCount: 1,
      });
      expect(await view(sender, schedule.id)).toMatchObject({
        status: 'paused',
        pausedReason: 'amount_below_minimum',
      });
      await waitFor(
        async () =>
          (await notificationsOf(sender, 'scheduled_payment_paused')).length ===
          1,
      );
      const [paused] = await notificationsOf(
        sender,
        'scheduled_payment_paused',
      );
      expect(paused.body).toContain('the amount is below the current minimum');
    });

    it('sender_unverified: a sender dropped to tier 0 is retried like any transient failure', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      const run = await claimRun(schedule.id);
      await ctx.userRepo.update({ id: sender.userId }, { kycTier: 'tier0' });

      await atClock(lagosAt(lagosToday(run.dueAt), '08:00'), () =>
        execute(run.id),
      );

      expect((await attemptsOf(run.id))[0].failureCode).toBe(
        'sender_unverified',
      );
      const after = await reload(run.id);
      expect(after.status).toBe('pending');
      expect(after.nextAttemptAt).not.toBeNull();
      expect((await view(sender, schedule.id)).status).toBe('active');
    });

    it('tells the sender their account needs identity verification when the last attempt fails', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      const run = await claimRun(schedule.id);
      await ctx.userRepo.update({ id: sender.userId }, { kycTier: 'tier0' });

      expect((await executeAtNightfall(run)).status).toBe('failed');

      await waitFor(
        async () =>
          (await notificationsOf(sender, 'scheduled_payment_run_failed'))
            .length === 1,
      );
      const [failed] = await notificationsOf(
        sender,
        'scheduled_payment_run_failed',
      );
      expect(failed.body).toContain(
        'your account needs identity verification to send',
      );
      expect((await view(sender, schedule.id)).status).toBe('active');
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
