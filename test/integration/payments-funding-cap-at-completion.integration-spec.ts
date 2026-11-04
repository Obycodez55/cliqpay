import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
} from './support/payments-test-context';
import {
  TIER1_CAP,
  balanceOf,
  creditWallet,
  deliverChargeSuccess,
  seedPendingFunding,
  seedUser,
} from './support/funding-completion';
import { assertInvariantHolds } from './support/ledger-invariant';
import { Money } from '../../src/shared/primitives/money';

jest.setTimeout(180_000);

describe('Balance cap when a funding completes', () => {
  let ctx: PaymentsTestContext;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  const statusOf = async (reference: string) =>
    (await ctx.transactionRepo.findOneByOrFail({ reference })).status;

  async function suspenseBalance(): Promise<bigint> {
    return (
      await ctx.accountRepo.findOneByOrFail({
        role: 'suspense',
        provider: 'kora',
        currency: 'NGN',
      })
    ).balance;
  }

  it('credits a funding that lands exactly on the cap', async () => {
    const { walletId } = await seedUser(ctx, 'tier1');
    await creditWallet(ctx, walletId, TIER1_CAP - 1_000_000n);
    const reference = await seedPendingFunding(ctx, walletId, 1_000_000n);

    await deliverChargeSuccess(ctx, reference, 1_000_000n);

    expect(await statusOf(reference)).toBe('completed');
    expect(await balanceOf(ctx, walletId)).toBe(TIER1_CAP);
    await assertInvariantHolds(ctx.accountRepo);
  });

  it('holds a funding that is one kobo over the cap: wallet untouched, money in suspense, a pending refund attempt created', async () => {
    const { walletId } = await seedUser(ctx, 'tier1');
    await creditWallet(ctx, walletId, TIER1_CAP - 999_999n);
    const reference = await seedPendingFunding(ctx, walletId, 1_000_000n);
    const suspenseBefore = await suspenseBalance();

    await deliverChargeSuccess(ctx, reference, 1_000_000n);

    expect(await statusOf(reference)).toBe('held');
    expect(await balanceOf(ctx, walletId)).toBe(TIER1_CAP - 999_999n);
    expect(await suspenseBalance()).toBe(suspenseBefore + 1_000_000n);
    const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
    const attempt = await ctx.transactionRepo.findOneByOrFail({
      type: 'funding_refund',
      reversesTransactionId: funding.id,
    });
    expect(attempt).toMatchObject({
      status: 'pending',
      reference: `rfd-${funding.id}-1`,
      amount: 1_000_000n,
    });
    await assertInvariantHolds(ctx.accountRepo);
  });

  it('holds a funding for a user whose tier has a zero cap', async () => {
    const { walletId } = await seedUser(ctx, 'tier0');
    const reference = await seedPendingFunding(ctx, walletId, 1_000_000n);

    await deliverChargeSuccess(ctx, reference, 1_000_000n);

    expect(await statusOf(reference)).toBe('held');
    expect(await balanceOf(ctx, walletId)).toBe(0n);
  });

  it('always credits a tier with no cap', async () => {
    const { walletId } = await seedUser(ctx, 'tier3');
    await creditWallet(ctx, walletId, 900_000_000n);
    const reference = await seedPendingFunding(ctx, walletId, 900_000_000n);

    await deliverChargeSuccess(ctx, reference, 900_000_000n);

    expect(await statusOf(reference)).toBe('completed');
    expect(await balanceOf(ctx, walletId)).toBe(1_800_000_000n);
  });

  it('does not count the user’s other pending fundings against the one completing', async () => {
    const { walletId } = await seedUser(ctx, 'tier1');
    const first = await seedPendingFunding(ctx, walletId, 20_000_000n);
    await seedPendingFunding(ctx, walletId, 10_000_000n);
    await creditWallet(ctx, walletId, 5_000_000n);

    await deliverChargeSuccess(ctx, first, 20_000_000n);

    expect(await statusOf(first)).toBe('completed');
    expect(await balanceOf(ctx, walletId)).toBe(25_000_000n);
  });

  it('a duplicate webhook for a held funding holds it once', async () => {
    const { walletId } = await seedUser(ctx, 'tier1');
    await creditWallet(ctx, walletId, TIER1_CAP);
    const reference = await seedPendingFunding(ctx, walletId, 1_000_000n);
    const suspenseBefore = await suspenseBalance();

    await deliverChargeSuccess(ctx, reference, 1_000_000n);
    await deliverChargeSuccess(ctx, reference, 1_000_000n);

    expect(await suspenseBalance()).toBe(suspenseBefore + 1_000_000n);
    const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
    expect(
      await ctx.transactionRepo.countBy({
        type: 'funding_refund',
        reversesTransactionId: funding.id,
      }),
    ).toBe(1);
  });

  it('the webhook racing the poll holds the funding exactly once', async () => {
    const { walletId } = await seedUser(ctx, 'tier1');
    await creditWallet(ctx, walletId, TIER1_CAP);
    const reference = await seedPendingFunding(ctx, walletId, 1_000_000n, 1);
    await ctx.transactionRepo.query(
      `UPDATE transactions SET created_at = now() - interval '20 minutes' WHERE reference = $1`,
      [reference],
    );
    ctx.fakeAdapter.setVerifyChargeResult(reference, {
      status: 'success',
      netAmount: Money.of(1_000_000n, 'NGN'),
      providerFee: Money.of(5_000n, 'NGN'),
    });
    const suspenseBefore = await suspenseBalance();

    await Promise.all([
      deliverChargeSuccess(ctx, reference, 1_000_000n),
      ctx.paymentsService.pollStaleFundingTransactions(),
    ]);

    expect(await statusOf(reference)).toBe('held');
    expect(await suspenseBalance()).toBe(suspenseBefore + 1_000_000n);
    const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
    expect(
      await ctx.transactionRepo.countBy({
        type: 'funding_refund',
        reversesTransactionId: funding.id,
      }),
    ).toBe(1);
  });

  it('holds a funding found over the cap by the poll as well', async () => {
    const { walletId } = await seedUser(ctx, 'tier1');
    await creditWallet(ctx, walletId, TIER1_CAP);
    const reference = await seedPendingFunding(ctx, walletId, 1_000_000n);
    await ctx.transactionRepo.query(
      `UPDATE transactions SET created_at = now() - interval '20 minutes' WHERE reference = $1`,
      [reference],
    );
    ctx.fakeAdapter.setVerifyChargeResult(reference, {
      status: 'success',
      netAmount: Money.of(1_000_000n, 'NGN'),
      providerFee: Money.zero('NGN'),
    });

    await ctx.paymentsService.pollStaleFundingTransactions();

    expect(await statusOf(reference)).toBe('held');
    expect(await balanceOf(ctx, walletId)).toBe(TIER1_CAP);
  });
});
