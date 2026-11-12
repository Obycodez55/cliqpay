import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
} from './support/payments-test-context';
import {
  balanceOf,
  deliverChargeSuccess,
  seedPendingFunding,
  seedUser,
} from './support/funding-completion';
import { assertInvariantHolds } from './support/ledger-invariant';

jest.setTimeout(180_000);

const HOUR_MS = 60 * 60 * 1000;

describe('New-account inflow cap when a funding completes', () => {
  let ctx: PaymentsTestContext;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  const statusOf = async (reference: string) =>
    (await ctx.transactionRepo.findOneByOrFail({ reference })).status;

  async function newcomer(reached = new Date()) {
    const user = await seedUser(ctx, 'tier1');
    await ctx.userRepo.update({ id: user.userId }, { tier1ReachedAt: reached });
    return user;
  }

  it('credits fundings up to the cap, holds and refunds the one that would pass it, and does not count the held one', async () => {
    const { walletId } = await newcomer();
    const first = await seedPendingFunding(ctx, walletId, 1_500_000n);
    await deliverChargeSuccess(ctx, first, 1_500_000n);
    expect(await statusOf(first)).toBe('completed');

    const over = await seedPendingFunding(ctx, walletId, 600_000n);
    await deliverChargeSuccess(ctx, over, 600_000n);

    expect(await statusOf(over)).toBe('held');
    expect(await balanceOf(ctx, walletId)).toBe(1_500_000n);
    const funding = await ctx.transactionRepo.findOneByOrFail({
      reference: over,
    });
    await expect(
      ctx.transactionRepo.findOneByOrFail({
        type: 'funding_refund',
        reversesTransactionId: funding.id,
      }),
    ).resolves.toMatchObject({ status: 'pending', amount: 600_000n });

    const fits = await seedPendingFunding(ctx, walletId, 500_000n);
    await deliverChargeSuccess(ctx, fits, 500_000n);
    expect(await statusOf(fits)).toBe('completed');
    expect(await balanceOf(ctx, walletId)).toBe(2_000_000n);
    await assertInvariantHolds(ctx.accountRepo);
  });

  it('credits any amount once the window has passed', async () => {
    const { walletId } = await newcomer(new Date(Date.now() - 25 * HOUR_MS));
    const reference = await seedPendingFunding(ctx, walletId, 2_500_000n);

    await deliverChargeSuccess(ctx, reference, 2_500_000n);

    expect(await statusOf(reference)).toBe('completed');
  });
});
