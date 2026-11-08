import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  ScheduleUser,
  atClock,
  createSchedulingHelpers,
  createSchedulingTestContext,
  lagosAt,
} from './support/scheduling-test-context';
import { dataOf } from './support/api-response';
import { waitFor } from './support/social-blocks-test-helpers';
import { SCHEDULED_PAYMENT_RUNS_QUEUE } from '../../src/modules/scheduling/internal/queues';
import {
  addDays,
  lagosToday,
} from '../../src/modules/scheduling/internal/run-time';
import { ScheduledPaymentAttempt } from '../../src/modules/scheduling/entities/scheduled-payment-attempt.entity';
import { ScheduledPaymentRun } from '../../src/modules/scheduling/entities/scheduled-payment-run.entity';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { WithdrawalsService } from '../../src/modules/withdrawals/withdrawals.service';

jest.setTimeout(180_000);

const HOUR_MS = 3_600_000;
const AMOUNT = 100_000n;
const FEE = 3_000n;

describe('Scheduled payments to bank accounts: running and settling', () => {
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

  async function seedSchedule(
    options: { body?: Record<string, unknown>; balanceMinor?: bigint } = {},
  ) {
    const sender = await h.seedUser('sender', {
      balanceMinor: options.balanceMinor ?? 5_000_000n,
    });
    const bank = await h.seedBank(sender.userId, {
      bankName: 'GTBank',
      accountNumber: '0123454821',
    });
    const schedule = dataOf<ScheduleBody>(
      await h
        .createBankSchedule(sender.userId, bank.id, options.body)
        .expect(201),
    );
    return { sender, bank, schedule };
  }

  const daily = { interval: { unit: 'day', count: 1 } };
  const date = () => addDays(lagosToday(new Date()), 10);
  const nightOf = (hours: number, d = date()) =>
    new Date(lagosAt(d, '08:00').getTime() + hours * HOUR_MS);

  // A pending run as the sweep leaves it. A recurring schedule keeps its
  // next run, so the schedule has a run left to pause before.
  async function insertRun(
    scheduleId: string,
    runNumber = 1,
    options: { keepNextRun?: boolean } = {},
  ) {
    if (!options.keepNextRun) {
      await h.scheduleRepo().update({ id: scheduleId }, { nextRunAt: null });
    }
    if (options.keepNextRun) {
      await h
        .scheduleRepo()
        .update({ id: scheduleId }, { nextRunNumber: runNumber + 1 });
    }
    const schedule = await h.scheduleRepo().findOneByOrFail({ id: scheduleId });
    return h.runRepo().save(
      h.runRepo().create({
        scheduledPaymentId: schedule.id,
        runNumber,
        dueAt: lagosAt(date(), '06:00'),
        status: 'pending',
        amount: schedule.amount,
        targetType: schedule.targetType,
        recipientUserId: null,
        bankAccountId: schedule.bankAccountId,
        note: schedule.note,
        visibility: null,
      }),
    );
  }

  const execute = (run: ScheduledPaymentRun, at = nightOf(0)) =>
    atClock(at, () => h.engine().executeRun(run.id));
  const reload = (runId: string) => h.runRepo().findOneByOrFail({ id: runId });
  const scheduleOf = (id: string) => h.scheduleRepo().findOneByOrFail({ id });
  const attemptsOf = (runId: string) =>
    ctx.dataSource.getRepository(ScheduledPaymentAttempt).find({
      where: { runId },
      order: { attemptNumber: 'ASC', createdAt: 'ASC' },
    });
  const balanceOf = async (user: ScheduleUser) =>
    (await ctx.accountRepo.findOneByOrFail({ id: user.walletId })).balance;
  const notificationsOf = (user: ScheduleUser, type: string) =>
    ctx.notificationRepo.findBy({ userId: user.userId, type });
  const refOf = (scheduleId: string, run: number, attempt: number) =>
    `sched_${scheduleId}_${run}_${attempt}`;

  const rejectNextPayout = () =>
    jest.spyOn(h.fakeAdapter(), 'initiatePayout').mockResolvedValueOnce({
      status: 'rejected',
      reason: 'Invalid bank provided.',
    });

  async function waitForStatus(runId: string, status: string) {
    await waitFor(async () => (await reload(runId)).status === status, 20_000);
  }

  describe('a run that is accepted', () => {
    it('sweeps, pays through withdrawals into settling, then settles to succeeded when the payout completes', async () => {
      const { sender, bank, schedule } = await seedSchedule();
      await h.makeDue(schedule.id);

      await h.engine().sweep();
      await waitForStatus((await h.runsOf(schedule.id))[0].id, 'settling');

      const [run] = await h.runsOf(schedule.id);
      const reference = refOf(schedule.id, 1, 1);
      const tx = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(tx).toMatchObject({
        type: 'withdrawal',
        status: 'pending',
        amount: AMOUNT,
      });
      expect(tx.metadata).toMatchObject({
        scheduleId: schedule.id,
        runNumber: 1,
        bankAccount: { id: bank.id, bankName: 'GTBank' },
      });
      expect(
        (tx.metadata as { bankAccount: { accountNumber: string } }).bankAccount
          .accountNumber,
      ).toBe('******4821');
      expect(run).toMatchObject({
        status: 'settling',
        transactionId: tx.id,
        attemptCount: 1,
        nextAttemptAt: null,
        targetType: 'bank_account',
        bankAccountId: bank.id,
        recipientUserId: null,
        visibility: null,
      });
      expect(await balanceOf(sender)).toBe(5_000_000n - AMOUNT - FEE);
      expect(
        (await attemptsOf(run.id)).map((a) => [
          a.kind,
          a.attemptNumber,
          a.outcome,
          a.transactionId,
        ]),
      ).toEqual([['attempt', 1, 'settling', tx.id]]);
      expect(await scheduleOf(schedule.id)).toMatchObject({
        status: 'completed',
      });

      await h.settlePayout(reference, 'success', AMOUNT);
      await waitForStatus(run.id, 'succeeded');

      expect(
        (await attemptsOf(run.id)).map((a) => [
          a.kind,
          a.attemptNumber,
          a.reference,
          a.outcome,
          a.failureCode,
          a.transactionId,
        ]),
      ).toEqual([
        ['attempt', 1, reference, 'settling', null, tx.id],
        ['settled', 1, reference, 'succeeded', null, tx.id],
      ]);
      expect(await balanceOf(sender)).toBe(5_000_000n - AMOUNT - FEE);
    });

    it('resets consecutive failures only once the run reaches succeeded', async () => {
      const { schedule } = await seedSchedule({ body: daily });
      await h
        .scheduleRepo()
        .update({ id: schedule.id }, { consecutiveFailures: 2 });
      const run = await insertRun(schedule.id, 1, { keepNextRun: true });

      await execute(run);
      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(2);
      await h.settlePayout(refOf(schedule.id, 1, 1), 'success', AMOUNT);
      await waitForStatus(run.id, 'succeeded');

      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(0);
    });

    it('does not block the next run or the schedule’s completion', async () => {
      const { schedule } = await seedSchedule({ body: daily });
      const first = await insertRun(schedule.id, 1, { keepNextRun: true });
      await execute(first);
      expect((await reload(first.id)).status).toBe('settling');

      await h.makeDue(schedule.id);
      await h.engine().sweep();
      const second = (await h.runsOf(schedule.id)).find(
        (r) => r.runNumber === 2,
      )!;
      await waitForStatus(second.id, 'settling');

      expect((await reload(first.id)).status).toBe('settling');
      expect(
        await ctx.transactionRepo.countBy({
          reference: refOf(schedule.id, 2, 1),
        }),
      ).toBe(1);
      await h.cancelSchedule(
        (await scheduleOf(schedule.id)).userId,
        schedule.id,
      );
    });
  });

  describe('a run whose provider answer is unknown', () => {
    it('is settling with its transaction, and settles when the webhook arrives', async () => {
      const { schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      jest.spyOn(h.fakeAdapter(), 'initiatePayout').mockResolvedValueOnce({
        status: 'unknown',
        detail: 'simulated network timeout',
      });

      await execute(run);

      const tx = await ctx.transactionRepo.findOneByOrFail({
        reference: refOf(schedule.id, 1, 1),
      });
      expect(tx.status).toBe('pending');
      expect(await reload(run.id)).toMatchObject({
        status: 'settling',
        transactionId: tx.id,
      });
      expect((await attemptsOf(run.id))[0]).toMatchObject({
        outcome: 'settling',
        failureCode: null,
      });
      await h.settlePayout(refOf(schedule.id, 1, 1), 'success', AMOUNT);
      await waitForStatus(run.id, 'succeeded');
    });
  });

  describe('a payout the provider rejects synchronously', () => {
    it('is payout_rejected, retried under a new reference, and then settles', async () => {
      const { sender, schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      rejectNextPayout();
      const first = nightOf(0);

      await execute(run, first);

      const rejected = await ctx.transactionRepo.findOneByOrFail({
        reference: refOf(schedule.id, 1, 1),
      });
      expect(rejected.status).toBe('reversed');
      expect(await balanceOf(sender)).toBe(5_000_000n);
      expect(await reload(run.id)).toMatchObject({
        status: 'pending',
        attemptCount: 1,
        nextAttemptAt: nightOf(2),
        transactionId: null,
      });
      expect((await attemptsOf(run.id))[0]).toMatchObject({
        outcome: 'failed',
        failureCode: 'payout_rejected',
        reference: refOf(schedule.id, 1, 1),
      });

      await execute(run, nightOf(2));

      const retried = await ctx.transactionRepo.findOneByOrFail({
        reference: refOf(schedule.id, 1, 2),
      });
      expect(retried.status).toBe('pending');
      expect(await reload(run.id)).toMatchObject({
        status: 'settling',
        attemptCount: 2,
        transactionId: retried.id,
      });
      expect(
        (await attemptsOf(run.id)).map((a) => [a.attemptNumber, a.outcome]),
      ).toEqual([
        [1, 'failed'],
        [2, 'settling'],
      ]);
      expect(await balanceOf(sender)).toBe(5_000_000n - AMOUNT - FEE);
      await h.settlePayout(refOf(schedule.id, 1, 2), 'success', AMOUNT);
      await waitForStatus(run.id, 'succeeded');
      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(0);
    });

    it('fails the run after the last attempt and tells the sender once', async () => {
      const { sender, schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      jest
        .spyOn(h.fakeAdapter(), 'initiatePayout')
        .mockResolvedValue({ status: 'rejected', reason: 'No' });

      for (const hours of [0, 2, 4, 6]) {
        await execute(run, nightOf(hours));
      }

      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        attemptCount: 4,
      });
      expect(await balanceOf(sender)).toBe(5_000_000n);
      await waitFor(
        async () =>
          (await notificationsOf(sender, 'scheduled_payment_run_failed'))
            .length === 1,
      );
      const [note] = await notificationsOf(
        sender,
        'scheduled_payment_run_failed',
      );
      expect(note.body).toContain('GTBank ••4821');
      expect(note.body).toContain('the bank rejected the payment');
    });

    it('is not touched by a withdrawal_failed for the rejected attempt’s reference', async () => {
      const { schedule } = await seedSchedule({ body: daily });
      const run = await insertRun(schedule.id, 1, { keepNextRun: true });
      rejectNextPayout();
      await execute(run);
      const before = await scheduleOf(schedule.id);

      await h.engine().recordSettlement('failed', refOf(schedule.id, 1, 1));
      await ctx.ledgerService.reverseWithdrawal({
        reference: refOf(schedule.id, 1, 1),
        reason: 'already reversed',
      });

      expect(await reload(run.id)).toMatchObject({
        status: 'pending',
        attemptCount: 1,
      });
      expect((await attemptsOf(run.id)).map((a) => a.kind)).toEqual([
        'attempt',
      ]);
      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(
        before.consecutiveFailures,
      );
    });
  });

  describe('a payout that fails after it was accepted', () => {
    it('reverses the run, refunds the wallet, retries nothing and sends no extra failure notice', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      const run = await insertRun(schedule.id, 1, { keepNextRun: true });
      await execute(run);

      await h.settlePayout(refOf(schedule.id, 1, 1), 'failed', AMOUNT);
      await waitForStatus(run.id, 'reversed');

      expect(await reload(run.id)).toMatchObject({
        status: 'reversed',
        nextAttemptAt: null,
      });
      expect(
        (await attemptsOf(run.id)).map((a) => [a.kind, a.outcome]),
      ).toEqual([
        ['attempt', 'settling'],
        ['reversed', 'failed'],
      ]);
      expect(await balanceOf(sender)).toBe(5_000_000n);
      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(1);
      expect(
        await ctx.transactionRepo.countBy({
          reference: refOf(schedule.id, 1, 2),
        }),
      ).toBe(0);
      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) => m.to === sender.email && /withdrawal/i.test(m.subject),
        ),
      );
      await h.waitForQueuesDrained();
      expect(
        await notificationsOf(sender, 'scheduled_payment_run_failed'),
      ).toHaveLength(0);
      expect(
        await notificationsOf(sender, 'scheduled_payment_paused'),
      ).toHaveLength(0);
    });

    it('pauses the schedule after 3 reversed runs in a row, with the usual notice', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });

      for (const runNumber of [1, 2, 3]) {
        const run = await insertRun(schedule.id, runNumber, {
          keepNextRun: true,
        });
        await execute(run);
        await h.settlePayout(
          refOf(schedule.id, runNumber, 1),
          'failed',
          AMOUNT,
        );
        await waitForStatus(run.id, 'reversed');
      }

      expect(await scheduleOf(schedule.id)).toMatchObject({
        status: 'paused',
        pausedReason: 'consecutive_failures',
        consecutiveFailures: 3,
        nextRunAt: null,
      });
      await waitFor(async () =>
        Boolean((await notificationsOf(sender, 'scheduled_payment_paused'))[0]),
      );
      const [paused] = await notificationsOf(
        sender,
        'scheduled_payment_paused',
      );
      expect(paused.body).toContain('GTBank ••4821');
      expect(await balanceOf(sender)).toBe(5_000_000n);
      await h.waitForQueuesDrained();
      expect(
        await notificationsOf(sender, 'scheduled_payment_run_failed'),
      ).toHaveLength(0);
    });

    it('cancels a later pending run, even one waiting to retry, when a reversal pauses the schedule', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      for (const runNumber of [1, 2]) {
        const earlier = await insertRun(schedule.id, runNumber, {
          keepNextRun: true,
        });
        await execute(earlier);
        await h.settlePayout(
          refOf(schedule.id, runNumber, 1),
          'failed',
          AMOUNT,
        );
        await waitForStatus(earlier.id, 'reversed');
      }
      const third = await insertRun(schedule.id, 3, { keepNextRun: true });
      await execute(third);
      const later = await insertRun(schedule.id, 4, { keepNextRun: true });
      await h
        .runRepo()
        .update(
          { id: later.id },
          { attemptCount: 1, nextAttemptAt: new Date(Date.now() - 1_000) },
        );

      await h.settlePayout(refOf(schedule.id, 3, 1), 'failed', AMOUNT);
      await waitForStatus(third.id, 'reversed');

      expect((await scheduleOf(schedule.id)).status).toBe('paused');
      expect(await reload(later.id)).toMatchObject({
        status: 'cancelled',
        nextAttemptAt: null,
      });
      const balance = await balanceOf(sender);
      await execute(later);
      expect((await reload(later.id)).status).toBe('cancelled');
      expect(
        await ctx.transactionRepo.countBy({
          reference: refOf(schedule.id, 4, 2),
        }),
      ).toBe(0);
      expect(await balanceOf(sender)).toBe(balance);
    });

    it('does not let a succeeded run in between hide the streak', async () => {
      const { schedule } = await seedSchedule({ body: daily });
      const outcomes = ['failed', 'failed', 'success', 'failed'] as const;

      for (const [index, outcome] of outcomes.entries()) {
        const run = await insertRun(schedule.id, index + 1, {
          keepNextRun: true,
        });
        await execute(run);
        await h.settlePayout(refOf(schedule.id, index + 1, 1), outcome, AMOUNT);
        await waitForStatus(
          run.id,
          outcome === 'success' ? 'succeeded' : 'reversed',
        );
      }

      expect(await scheduleOf(schedule.id)).toMatchObject({
        status: 'active',
        consecutiveFailures: 1,
      });
      await h.cancelSchedule(
        (await scheduleOf(schedule.id)).userId,
        schedule.id,
      );
    });
  });

  describe('a removed bank account', () => {
    it('fails the run permanently and pauses the schedule at once', async () => {
      const { sender, bank, schedule } = await seedSchedule({ body: daily });
      const run = await insertRun(schedule.id, 1, { keepNextRun: true });
      await ctx.dataSource.query(`DELETE FROM bank_accounts WHERE id = $1`, [
        bank.id,
      ]);

      await execute(run);

      expect(await reload(run.id)).toMatchObject({
        status: 'failed',
        nextAttemptAt: null,
      });
      expect((await attemptsOf(run.id))[0]).toMatchObject({
        outcome: 'failed',
        failureCode: 'bank_account_removed',
      });
      expect(await scheduleOf(schedule.id)).toMatchObject({
        status: 'paused',
        pausedReason: 'bank_account_removed',
      });
      expect(await balanceOf(sender)).toBe(5_000_000n);
      await waitFor(async () =>
        Boolean((await notificationsOf(sender, 'scheduled_payment_paused'))[0]),
      );
      const [paused] = await notificationsOf(
        sender,
        'scheduled_payment_paused',
      );
      expect(paused.body).toContain('no longer saved');
      await waitFor(async () =>
        Boolean(
          (await notificationsOf(sender, 'scheduled_payment_run_failed'))[0],
        ),
      );
    });
  });

  describe('other business refusals', () => {
    it('retries an insufficient balance and pauses at once for a frozen sender', async () => {
      const poor = await seedSchedule({ balanceMinor: 50_000n });
      const poorRun = await insertRun(poor.schedule.id);
      await execute(poorRun);
      expect(await reload(poorRun.id)).toMatchObject({ status: 'pending' });
      expect((await attemptsOf(poorRun.id))[0].failureCode).toBe(
        'insufficient_balance',
      );

      const frozen = await seedSchedule({ body: daily });
      const frozenRun = await insertRun(frozen.schedule.id, 1, {
        keepNextRun: true,
      });
      await ctx.userRepo.update(
        { id: frozen.sender.userId },
        { isFrozen: true },
      );
      await execute(frozenRun);
      expect((await attemptsOf(frozenRun.id))[0].failureCode).toBe(
        'sender_frozen',
      );
      expect(await scheduleOf(frozen.schedule.id)).toMatchObject({
        status: 'paused',
        pausedReason: 'sender_frozen',
      });
    });
  });

  describe('duplicate and stray settlement events', () => {
    it('ignores a duplicate, a flip after the fact, and unknown or foreign references', async () => {
      const { schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      await execute(run);
      const reference = refOf(schedule.id, 1, 1);
      await h.settlePayout(reference, 'success', AMOUNT);
      await waitForStatus(run.id, 'succeeded');
      const settled = await attemptsOf(run.id);

      await h.engine().recordSettlement('completed', reference);
      await h.engine().recordSettlement('failed', reference);
      await h.engine().recordSettlement('failed', refOf(schedule.id, 1, 2));
      await h.engine().recordSettlement('failed', refOf(schedule.id, 9, 1));
      await h
        .engine()
        .recordSettlement(
          'failed',
          'sched_00000000-0000-4000-8000-000000000000_1_1',
        );
      await h.engine().recordSettlement('failed', 'cliqpay-withdrawal-1');

      expect(await reload(run.id)).toMatchObject({ status: 'succeeded' });
      expect(await attemptsOf(run.id)).toHaveLength(settled.length);
    });

    it('ignores a stray event delivered through the bus for a run that is not settling', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      const run = await insertRun(schedule.id, 1, { keepNextRun: true });

      await ctx.app.get(EventBusService, { strict: false }).publish({
        name: 'withdrawal_failed',
        payload: {
          userId: sender.userId,
          email: sender.email,
          amount: '1000.00',
          currency: 'NGN',
          reference: refOf(schedule.id, 1, 1),
          reason: 'stray',
        },
        occurredAt: new Date(),
      });
      await h.waitForQueuesDrained();

      expect(await reload(run.id)).toMatchObject({
        status: 'pending',
        attemptCount: 0,
      });
      expect(await attemptsOf(run.id)).toHaveLength(0);
      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(0);
    });

    it('settles a run when the webhook’s event arrives through the bus once, and ignores the second delivery', async () => {
      const { schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      await execute(run);
      const reference = refOf(schedule.id, 1, 1);

      await h.settlePayout(reference, 'success', AMOUNT);
      await h.settlePayout(reference, 'success', AMOUNT);
      await waitForStatus(run.id, 'succeeded');
      await h.waitForQueuesDrained();

      expect(
        (await attemptsOf(run.id)).filter((a) => a.kind === 'settled'),
      ).toHaveLength(1);
    });
  });

  describe('recovering from a fault around the payout', () => {
    it('reuses the reference on a retry, finds the pending withdrawal and records the run as settling without a second debit', async () => {
      const { sender, schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      jest
        .spyOn(h.fakeAdapter(), 'initiatePayout')
        .mockRejectedValueOnce(new Error('connection reset'));

      await expect(execute(run)).rejects.toThrow('connection reset');
      expect(await reload(run.id)).toMatchObject({
        status: 'pending',
        attemptCount: 0,
      });
      await execute(run);

      const tx = await ctx.transactionRepo.findOneByOrFail({
        reference: refOf(schedule.id, 1, 1),
      });
      expect(await reload(run.id)).toMatchObject({
        status: 'settling',
        attemptCount: 1,
        transactionId: tx.id,
      });
      expect(await balanceOf(sender)).toBe(5_000_000n - AMOUNT - FEE);
    });

    it('records a posted, still pending withdrawal as settling when the queue gives up', async () => {
      const { schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      jest
        .spyOn(h.fakeAdapter(), 'initiatePayout')
        .mockRejectedValueOnce(new Error('connection reset'));
      await expect(execute(run)).rejects.toThrow();

      await h.engine().recordInfrastructureFailure(run.id);

      const tx = await ctx.transactionRepo.findOneByOrFail({
        reference: refOf(schedule.id, 1, 1),
      });
      expect(await reload(run.id)).toMatchObject({
        status: 'settling',
        transactionId: tx.id,
      });
      expect((await attemptsOf(run.id))[0]).toMatchObject({
        outcome: 'settling',
        transactionId: tx.id,
      });
    });

    it('records a posted and already reversed withdrawal as a rejected payout and retries under a new reference', async () => {
      const { sender, schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      rejectNextPayout();
      await expect(
        ctx.app
          .get(WithdrawalsService, { strict: false })
          .executeScheduledWithdrawal(sender.userId, {
            bankAccountId: (await scheduleOf(schedule.id)).bankAccountId!,
            amount: Number(AMOUNT),
            reference: refOf(schedule.id, 1, 1),
            scheduleId: schedule.id,
            runNumber: 1,
          }),
      ).rejects.toMatchObject({ failureCode: 'payout_rejected' });

      await atClock(nightOf(0), () =>
        h.engine().recordInfrastructureFailure(run.id),
      );

      expect(await reload(run.id)).toMatchObject({
        status: 'pending',
        attemptCount: 1,
        transactionId: null,
      });
      expect((await attemptsOf(run.id))[0]).toMatchObject({
        outcome: 'failed',
        failureCode: 'payout_rejected',
      });
      await execute(run, nightOf(2));
      expect(await reload(run.id)).toMatchObject({
        status: 'settling',
        attemptCount: 2,
      });
    });

    it('records nothing posted as an infrastructure failure', async () => {
      const { schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);

      await atClock(nightOf(0), () =>
        h.engine().recordInfrastructureFailure(run.id),
      );

      expect((await attemptsOf(run.id))[0]).toMatchObject({
        outcome: 'failed',
        failureCode: 'infrastructure',
      });
    });
  });

  describe('a payout that resolves before the run is recorded', () => {
    const postWithdrawal = async (
      sender: ScheduleUser,
      scheduleId: string,
      reference: string,
    ) =>
      ctx.app
        .get(WithdrawalsService, { strict: false })
        .executeScheduledWithdrawal(sender.userId, {
          bankAccountId: (await scheduleOf(scheduleId)).bankAccountId!,
          amount: Number(AMOUNT),
          reference,
          scheduleId,
          runNumber: 1,
        });

    const resolveDuringExecution = (
      result: 'success' | 'failed',
      reference: string,
    ) => {
      const service = ctx.app.get<WithdrawalsService>(WithdrawalsService, {
        strict: false,
      });
      const original = service.executeScheduledWithdrawal.bind(
        service,
      ) as WithdrawalsService['executeScheduledWithdrawal'];
      jest
        .spyOn(service, 'executeScheduledWithdrawal')
        .mockImplementationOnce(async (userId: string, params) => {
          const posted = await original(userId, params);
          await h.settlePayout(reference, result, AMOUNT);
          await h
            .engine()
            .recordSettlement(
              result === 'success' ? 'completed' : 'failed',
              reference,
            );
          return posted;
        });
    };

    it('ends succeeded with a settled row when the payout completed first', async () => {
      const { schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      const reference = refOf(schedule.id, 1, 1);
      resolveDuringExecution('success', reference);

      await execute(run);

      expect(await reload(run.id)).toMatchObject({ status: 'succeeded' });
      const attempts = await attemptsOf(run.id);
      expect(attempts.map((a) => [a.kind, a.outcome])).toEqual([
        ['attempt', 'settling'],
        ['settled', 'succeeded'],
      ]);
      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(0);
    });

    it('ends reversed without a retry or failure notice when the payout failed first', async () => {
      const { sender, schedule } = await seedSchedule();
      const run = await insertRun(schedule.id, 1, { keepNextRun: true });
      resolveDuringExecution('failed', refOf(schedule.id, 1, 1));

      await execute(run);

      expect(await reload(run.id)).toMatchObject({
        status: 'reversed',
        nextAttemptAt: null,
      });
      const attempts = await attemptsOf(run.id);
      expect(attempts.map((a) => [a.kind, a.outcome])).toEqual([
        ['attempt', 'settling'],
        ['reversed', 'failed'],
      ]);
      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(1);
      expect(await balanceOf(sender)).toBe(5_000_000n);
      expect(
        await notificationsOf(sender, 'scheduled_payment_run_failed'),
      ).toHaveLength(0);
    });

    it('ends succeeded when a retry replays a withdrawal that already completed', async () => {
      const { sender, schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      const reference = refOf(schedule.id, 1, 1);
      await postWithdrawal(sender, schedule.id, reference);
      await h.settlePayout(reference, 'success', AMOUNT);

      await execute(run);

      expect(await reload(run.id)).toMatchObject({ status: 'succeeded' });
      expect((await attemptsOf(run.id)).map((a) => a.kind)).toEqual([
        'attempt',
        'settled',
      ]);
      expect(await balanceOf(sender)).toBe(5_000_000n - AMOUNT - FEE);
    });

    it('settles from the infrastructure-failure path when the withdrawal already completed', async () => {
      const { sender, schedule } = await seedSchedule();
      const run = await insertRun(schedule.id);
      const reference = refOf(schedule.id, 1, 1);
      await postWithdrawal(sender, schedule.id, reference);
      await h.settlePayout(reference, 'success', AMOUNT);

      await atClock(nightOf(0), () =>
        h.engine().recordInfrastructureFailure(run.id),
      );

      expect(await reload(run.id)).toMatchObject({ status: 'succeeded' });
      expect((await attemptsOf(run.id)).map((a) => a.kind)).toEqual([
        'attempt',
        'settled',
      ]);
    });
  });

  describe('notification labels', () => {
    it('labels a missed bank run with the bank name and masked number', async () => {
      const { sender, schedule } = await seedSchedule();
      jest.spyOn(queue(), 'addBulk').mockResolvedValue([] as never);
      await ctx.dataSource.query(
        `UPDATE scheduled_payments SET next_run_at = now() - interval '3 days' WHERE id = $1`,
        [schedule.id],
      );

      await h.engine().sweep();

      await waitFor(async () =>
        Boolean(
          (await notificationsOf(sender, 'scheduled_payment_runs_missed'))[0],
        ),
      );
      const [note] = await notificationsOf(
        sender,
        'scheduled_payment_runs_missed',
      );
      expect(note.body).toContain('GTBank ••4821');
      expect(note.body).not.toContain('0123454821');
    });
  });

  describe('a settling run whose event never arrives', () => {
    // The payout resolves in the ledger without the event reaching
    // scheduling, and the run is then old enough for the sweep to check.
    async function strandRun(ledgerStatus?: 'completed' | 'reversed') {
      const seeded = await seedSchedule({ body: daily });
      const run = await insertRun(seeded.schedule.id, 1, {
        keepNextRun: true,
      });
      await execute(run);
      expect((await reload(run.id)).status).toBe('settling');
      if (ledgerStatus) {
        await ctx.dataSource.query(
          `UPDATE transactions SET status = $1 WHERE reference = $2`,
          [ledgerStatus, refOf(seeded.schedule.id, 1, 1)],
        );
      }
      const age = () =>
        ctx.dataSource.query(
          `UPDATE scheduled_payment_runs SET updated_at = now() - interval '2 hours' WHERE id = $1`,
          [run.id],
        );
      return { ...seeded, run, age };
    }

    it('is settled by the sweep once the withdrawal completed', async () => {
      const { schedule, run, age } = await strandRun('completed');

      await h.engine().sweep();
      expect((await reload(run.id)).status).toBe('settling');

      await age();
      await h.engine().sweep();

      expect((await reload(run.id)).status).toBe('succeeded');
      expect(
        (await attemptsOf(run.id)).map((a) => [a.kind, a.outcome]),
      ).toEqual([
        ['attempt', 'settling'],
        ['settled', 'succeeded'],
      ]);
      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(0);
    });

    it('is reversed by the sweep once the withdrawal was reversed, and counts toward the pause', async () => {
      const { schedule, run, age } = await strandRun('reversed');

      await age();
      await h.engine().sweep();

      expect((await reload(run.id)).status).toBe('reversed');
      expect(
        (await attemptsOf(run.id)).map((a) => [a.kind, a.outcome]),
      ).toEqual([
        ['attempt', 'settling'],
        ['reversed', 'failed'],
      ]);
      expect((await scheduleOf(schedule.id)).consecutiveFailures).toBe(1);
    });

    it('leaves an old run alone while its payout is still pending', async () => {
      const { run, age } = await strandRun();

      await age();
      await h.engine().sweep();

      expect((await reload(run.id)).status).toBe('settling');
    });
  });

  describe('a minimum raised above the amount', () => {
    it('is amount_below_minimum and pauses the schedule', async () => {
      const { sender, schedule } = await seedSchedule({ body: daily });
      const run = await insertRun(schedule.id, 1, { keepNextRun: true });
      ctx.config.withdrawals.minAmount = 200_000;
      try {
        await execute(run);
      } finally {
        ctx.config.withdrawals.minAmount = 10_000;
      }

      expect((await attemptsOf(run.id))[0].failureCode).toBe(
        'amount_below_minimum',
      );
      expect((await reload(run.id)).status).toBe('failed');
      expect(await scheduleOf(schedule.id)).toMatchObject({
        status: 'paused',
        pausedReason: 'amount_below_minimum',
      });
      expect(await balanceOf(sender)).toBe(5_000_000n);
    });
  });

  describe('the low-balance reminder', () => {
    const eveningBefore = () => lagosAt(lagosToday(new Date()), '18:00');
    const UPCOMING = 'scheduled_payment_upcoming';

    it('counts the per-run fees: warns at amount + fees − 1, not at amount + fees', async () => {
      const short = await seedSchedule({ balanceMinor: AMOUNT + FEE - 1n });
      const covered = await seedSchedule({ balanceMinor: AMOUNT + FEE });
      const justAmount = await seedSchedule({ balanceMinor: AMOUNT });

      await h.engine().sendUpcomingReminders(eveningBefore());

      await waitFor(
        async () =>
          (await notificationsOf(short.sender, UPCOMING)).length === 1,
      );
      await waitFor(
        async () =>
          (await notificationsOf(justAmount.sender, UPCOMING)).length === 1,
      );
      await h.waitForQueuesDrained();
      expect(await notificationsOf(covered.sender, UPCOMING)).toHaveLength(0);
      const [note] = await notificationsOf(short.sender, UPCOMING);
      expect(note.body).toContain('GTBank ••4821');
      expect(note.body).toContain('NGN 30.00 in fees');
    });
  });
});
