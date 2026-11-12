import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  createSchedulingTestContext,
  lagosAt,
} from './support/scheduling-test-context';
import { waitFor } from './support/social-blocks-test-helpers';
import { lagosToday } from '../../src/modules/scheduling/internal/run-time';
import {
  createBankRunHelpers,
  AMOUNT,
  FEE,
} from './support/scheduling-bank-run-helpers';
import { addTestRestriction } from './support/restrictions';

jest.setTimeout(180_000);

describe('Scheduled payments to bank accounts: running', () => {
  let ctx: TransfersTestContext;
  const {
    h,
    queue,
    seedSchedule,
    daily,
    nightOf,
    insertRun,
    execute,
    reload,
    scheduleOf,
    attemptsOf,
    balanceOf,
    notificationsOf,
    refOf,
    rejectNextPayout,
    waitForStatus,
  } = createBankRunHelpers(() => ctx);

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
      await addTestRestriction(ctx.dataSource, frozen.sender.userId);
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
