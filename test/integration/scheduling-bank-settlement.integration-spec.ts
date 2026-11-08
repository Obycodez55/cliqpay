import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleUser,
  atClock,
  createSchedulingTestContext,
} from './support/scheduling-test-context';
import { waitFor } from './support/social-blocks-test-helpers';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { WithdrawalsService } from '../../src/modules/withdrawals/withdrawals.service';
import {
  createBankRunHelpers,
  AMOUNT,
  FEE,
} from './support/scheduling-bank-run-helpers';

jest.setTimeout(180_000);

describe('Scheduled payments to bank accounts: settling', () => {
  let ctx: TransfersTestContext;
  const {
    h,
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
});
