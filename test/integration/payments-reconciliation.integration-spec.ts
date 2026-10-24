import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
} from './support/payments-test-context';
import { RECONCILIATION_QUEUE } from '../../src/modules/payments/internal/reconciliation.processor';
import { Money } from '../../src/shared/primitives/money';
import { holdAFunding, waitFor } from './support/funding-completion';

jest.setTimeout(120_000);

describe('external reconciliation job', () => {
  let ctx: PaymentsTestContext;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  beforeEach(async () => {
    // float_ngn starts at 0 (system-account seed) — matched against a
    // provider balance the test sets explicitly per case.
    await ctx.accountRepo.update(
      { role: 'float', provider: 'kora', currency: 'NGN' },
      { balance: 0n },
    );
  });

  it('registers a repeatable hourly job scheduler, not a per-request job', async () => {
    const queue = ctx.app.get<Queue>(getQueueToken(RECONCILIATION_QUEUE));

    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ every: 3_600_000 });
  });

  it('does not touch the ledger when the ledger and provider balances match', async () => {
    ctx.fakeAdapter.setBalance('NGN', Money.zero('NGN'));

    await ctx.paymentsService.reconcileFloatBalances();

    const float = await ctx.accountRepo.findOneByOrFail({
      role: 'float',
      provider: 'kora',
      currency: 'NGN',
    });
    expect(float.balance).toBe(0n);
  });

  it('does not adjust float_ngn on a detected mismatch', async () => {
    ctx.fakeAdapter.setBalance('NGN', Money.of(500_000n, 'NGN'));

    await ctx.paymentsService.reconcileFloatBalances();

    const float = await ctx.accountRepo.findOneByOrFail({
      role: 'float',
      provider: 'kora',
      currency: 'NGN',
    });
    // Ledger stays exactly as it was — a mismatch is alerted, never
    // auto-corrected (CLAUDE.md, docs/architecture.md §4.4).
    expect(float.balance).toBe(0n);
  });

  describe('while money is held or a refund is in flight', () => {
    const mismatchAlerts = () =>
      ctx.emailAdapter.sent.filter(
        (m) =>
          m.to === 'ops@cliqpay.test' &&
          m.subject.startsWith('Reconciliation mismatch'),
      );

    // Each case starts with no refund in flight, whatever earlier cases left.
    beforeEach(async () => {
      await ctx.transactionRepo.query(
        `UPDATE transactions SET status = 'failed' WHERE type = 'funding_refund' AND status = 'pending'`,
      );
    });

    async function floatBalance(): Promise<bigint> {
      return (
        await ctx.accountRepo.findOneByOrFail({
          role: 'float',
          provider: 'kora',
          currency: 'NGN',
        })
      ).balance;
    }

    it('raises no alarm while a refund is in flight: Kora already debited it, the ledger has not settled it yet', async () => {
      await holdAFunding(ctx);
      const float = await floatBalance();
      ctx.fakeAdapter.setBalance('NGN', Money.of(float - 1_000_000n, 'NGN'));
      const before = mismatchAlerts().length;

      await ctx.paymentsService.reconcileFloatBalances();

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(mismatchAlerts()).toHaveLength(before);
    });

    it('raises no alarm for money held with no refund started: it is still in Kora’s balance', async () => {
      const initiate = jest.spyOn(ctx.fakeAdapter, 'initiateRefund');
      initiate.mockResolvedValueOnce({
        status: 'rejected',
        reason: 'Transaction not found',
      });
      await holdAFunding(ctx);
      initiate.mockRestore();
      ctx.fakeAdapter.setBalance('NGN', Money.of(await floatBalance(), 'NGN'));
      const before = mismatchAlerts().length;

      await ctx.paymentsService.reconcileFloatBalances();

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(mismatchAlerts()).toHaveLength(before);
    });

    it('still alerts on a real mismatch while a refund is in flight, and the alert carries the suspense and in-flight figures', async () => {
      await holdAFunding(ctx);
      const float = await floatBalance();
      ctx.fakeAdapter.setBalance(
        'NGN',
        Money.of(float - 1_000_000n - 5_000n, 'NGN'),
      );
      const before = mismatchAlerts().length;

      await ctx.paymentsService.reconcileFloatBalances();

      await waitFor(() => mismatchAlerts().length > before);
      const alert = mismatchAlerts()[before];
      const suspense = await ctx.ledgerService.getSuspenseBalance(
        'kora',
        'NGN',
      );
      expect(alert.html).toContain('NGN 50.00');
      expect(alert.html).toContain(`NGN ${suspense.toDecimalString()}`);
      expect(alert.html).toContain('NGN 10000.00');
      expect(alert.html).toContain('Held in suspense');
      expect(alert.html).toContain('Refunds in flight');
    });
  });
});
