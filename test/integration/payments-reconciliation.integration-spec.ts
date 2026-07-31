import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
} from './support/payments-test-context';
import { RECONCILIATION_QUEUE } from '../../src/modules/payments/internal/reconciliation.processor';
import { Money } from '../../src/shared/primitives/money';

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
});
