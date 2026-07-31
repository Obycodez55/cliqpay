import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
  seedUserWithWallet,
} from './support/payments-test-context';
import { FUNDING_POLL_QUEUE } from '../../src/modules/payments/internal/funding-poll.processor';
import { Money } from '../../src/shared/primitives/money';

jest.setTimeout(120_000);

const STALE_MINUTES = 11; // past the 10-minute threshold
const FRESH_MINUTES = 2; // within the normal webhook window

describe('funding self-verify poll job', () => {
  let ctx: PaymentsTestContext;
  let refCounter = 0;
  let phoneCounter = 0;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  function nextReference(prefix: string): string {
    refCounter += 1;
    return `${prefix}-${refCounter}`;
  }

  async function seedPendingFunding(
    reference: string,
    ageMinutes: number,
  ): Promise<{ userId: string; walletId: string }> {
    phoneCounter += 1;
    const suffix = reference.replace(/[^a-z0-9]/gi, '_');
    const seeded = await seedUserWithWallet(ctx, {
      email: `${reference}@example.com`,
      phone: `+234802${String(phoneCounter).padStart(7, '0')}`,
      username: `poll_user_${suffix}`,
    });
    await ctx.ledgerService.createPendingFundingTransaction({
      reference,
      provider: 'kora',
      providerReference: reference,
      amount: Money.of(500_000n, 'NGN'),
      recipientWalletId: seeded.walletId,
      metadata: {
        checkoutUrl: 'https://fake-checkout.cliqpay.test/x',
        grossAmount: null,
      },
    });
    await ctx.transactionRepo.update(
      { reference },
      { createdAt: new Date(Date.now() - ageMinutes * 60 * 1000) },
    );
    return seeded;
  }

  it('registers a repeatable 5-minute job scheduler, not a per-request job', async () => {
    const queue = ctx.app.get<Queue>(getQueueToken(FUNDING_POLL_QUEUE));

    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ every: 300_000 });
  });

  it('only resolves stale transactions, leaving ones inside the webhook window untouched', async () => {
    const staleRef = nextReference('poll-stale');
    const freshRef = nextReference('poll-fresh');
    await seedPendingFunding(staleRef, STALE_MINUTES);
    await seedPendingFunding(freshRef, FRESH_MINUTES);
    ctx.fakeAdapter.setVerifyChargeResult(staleRef, {
      status: 'success',
      netAmount: Money.of(500_000n, 'NGN'),
      providerFee: Money.of(5_000n, 'NGN'),
    });
    ctx.fakeAdapter.setVerifyChargeResult(freshRef, {
      status: 'success',
      netAmount: Money.of(500_000n, 'NGN'),
      providerFee: Money.of(5_000n, 'NGN'),
    });

    await ctx.paymentsService.pollStaleFundingTransactions();

    const stale = await ctx.transactionRepo.findOneByOrFail({
      reference: staleRef,
    });
    const fresh = await ctx.transactionRepo.findOneByOrFail({
      reference: freshRef,
    });
    expect(stale.status).toBe('completed');
    expect(fresh.status).toBe('pending');
  });

  it('marks a transaction Kora reports as failed, rather than leaving it pending forever', async () => {
    const reference = nextReference('poll-failed');
    await seedPendingFunding(reference, STALE_MINUTES);
    ctx.fakeAdapter.setVerifyChargeResult(reference, { status: 'failed' });

    await ctx.paymentsService.pollStaleFundingTransactions();

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('failed');
    const entries = await ctx.ledgerEntryRepo.findBy({
      transactionId: transaction.id,
    });
    expect(entries).toHaveLength(0);
  });

  it('leaves a transaction Kora still reports as unresolved as pending', async () => {
    const reference = nextReference('poll-pending');
    await seedPendingFunding(reference, STALE_MINUTES);
    ctx.fakeAdapter.setVerifyChargeResult(reference, { status: 'pending' });

    await ctx.paymentsService.pollStaleFundingTransactions();

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('pending');
  });

  it('is a no-op when the webhook already completed the transaction before the poll runs', async () => {
    const reference = nextReference('poll-race');
    await seedPendingFunding(reference, STALE_MINUTES);

    // The webhook wins the race first.
    const webhookResult = await ctx.ledgerService.postFunding({
      reference,
      netAmount: Money.of(500_000n, 'NGN'),
      providerFee: Money.of(5_000n, 'NGN'),
      providerStatus: 'success',
    });
    expect(webhookResult).not.toBeNull();
    const transactionAfterWebhook = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    const entriesAfterWebhook = await ctx.ledgerEntryRepo.findBy({
      transactionId: transactionAfterWebhook.id,
    });
    expect(entriesAfterWebhook).toHaveLength(4);

    // The poll job finds the same reference and must not double-post.
    ctx.fakeAdapter.setVerifyChargeResult(reference, {
      status: 'success',
      netAmount: Money.of(500_000n, 'NGN'),
      providerFee: Money.of(5_000n, 'NGN'),
    });
    await ctx.paymentsService.pollStaleFundingTransactions();

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('completed');
    const entriesAfterPoll = await ctx.ledgerEntryRepo.findBy({
      transactionId: transaction.id,
    });
    expect(entriesAfterPoll).toHaveLength(4);
  });
});
