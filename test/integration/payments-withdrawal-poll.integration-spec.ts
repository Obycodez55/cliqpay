import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  fundWallet,
  seedBankAccount,
  seedWithdrawalUser,
} from './support/withdrawals-test-context';
import { WITHDRAWAL_POLL_QUEUE } from '../../src/modules/payments/internal/withdrawal-poll.processor';
import { FakeAdapter } from '../../src/modules/payments/adapters/fake.adapter';
import { Money } from '../../src/shared/primitives/money';

jest.setTimeout(120_000);

const STALE_MINUTES = 11; // past the 10-minute threshold
const FRESH_MINUTES = 2; // within the normal webhook window

const AMOUNT = Money.of(50_000n, 'NGN');
const PLATFORM_FEE = Money.zero('NGN');
const PROVIDER_FEE = Money.of(3_000n, 'NGN');

describe('withdrawal self-verify poll job', () => {
  let ctx: WithdrawalsTestContext;
  let refCounter = 0;
  let phoneCounter = 0;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  function nextReference(prefix: string): string {
    refCounter += 1;
    return `${prefix}-${refCounter}`;
  }

  async function seedPendingWithdrawal(
    reference: string,
    ageMinutes: number,
  ): Promise<{ userId: string; walletId: string }> {
    phoneCounter += 1;
    const suffix = reference.replace(/[^a-z0-9]/gi, '_');
    const seeded = await seedWithdrawalUser(ctx, {
      email: `${reference}@example.com`,
      phone: `+234803${String(phoneCounter).padStart(7, '0')}`,
      username: `poll_user_${suffix}`,
    });
    await fundWallet(ctx, {
      reference: `${reference}-fund`,
      walletId: seeded.walletId,
      netAmountMinor: 1_000_000n,
    });
    const bankAccount = await seedBankAccount(ctx, { userId: seeded.userId });

    await ctx.ledgerService.postWithdrawal({
      reference,
      walletId: seeded.walletId,
      provider: 'kora',
      amount: AMOUNT,
      platformFee: PLATFORM_FEE,
      providerFee: PROVIDER_FEE,
      bankAccount: {
        id: bankAccount.id,
        bankCode: bankAccount.bankCode,
        bankName: bankAccount.bankName,
        accountNumber: bankAccount.accountNumber,
        accountName: bankAccount.accountName,
      },
    });
    await ctx.transactionRepo.update(
      { reference },
      { createdAt: new Date(Date.now() - ageMinutes * 60 * 1000) },
    );
    return seeded;
  }

  it('registers a repeatable 5-minute job scheduler, not a per-request job', async () => {
    const queue = ctx.app.get<Queue>(getQueueToken(WITHDRAWAL_POLL_QUEUE));

    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ every: 300_000 });
  });

  it('only resolves stale withdrawals, leaving ones inside the webhook window untouched', async () => {
    const staleRef = nextReference('wpoll-stale');
    const freshRef = nextReference('wpoll-fresh');
    await seedPendingWithdrawal(staleRef, STALE_MINUTES);
    await seedPendingWithdrawal(freshRef, FRESH_MINUTES);
    ctx.fakeAdapter.setVerifyPayoutResult(staleRef, {
      status: 'success',
      amount: AMOUNT,
    });
    ctx.fakeAdapter.setVerifyPayoutResult(freshRef, {
      status: 'success',
      amount: AMOUNT,
    });

    await ctx.paymentsService.pollStaleWithdrawalTransactions();

    const stale = await ctx.transactionRepo.findOneByOrFail({
      reference: staleRef,
    });
    const fresh = await ctx.transactionRepo.findOneByOrFail({
      reference: freshRef,
    });
    expect(stale.status).toBe('completed');
    expect(fresh.status).toBe('pending');
  });

  it('reverses a withdrawal Kora reports as failed, rather than leaving it pending forever', async () => {
    const reference = nextReference('wpoll-failed');
    await seedPendingWithdrawal(reference, STALE_MINUTES);
    ctx.fakeAdapter.setVerifyPayoutResult(reference, {
      status: 'failed',
      reason: 'Invalid bank account.',
    });

    await ctx.paymentsService.pollStaleWithdrawalTransactions();

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('reversed');
    const reversal = await ctx.transactionRepo.findOneByOrFail({
      reference: `${reference}-reversal`,
    });
    expect(reversal.type).toBe('withdrawal_reversal');
  });

  it('leaves a withdrawal Kora still reports as unresolved as pending', async () => {
    const reference = nextReference('wpoll-pending');
    await seedPendingWithdrawal(reference, STALE_MINUTES);
    ctx.fakeAdapter.setVerifyPayoutResult(reference, { status: 'pending' });

    await ctx.paymentsService.pollStaleWithdrawalTransactions();

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('pending');
  });

  it('is a no-op when the webhook already completed the transaction before the poll runs', async () => {
    const reference = nextReference('wpoll-race');
    await seedPendingWithdrawal(reference, STALE_MINUTES);

    // The webhook wins the race first.
    const webhookResult = await ctx.ledgerService.completeWithdrawal({
      reference,
      providerReportedAmount: AMOUNT,
    });
    expect(webhookResult).not.toBeNull();

    // The poll job finds the same reference and must not double-resolve.
    ctx.fakeAdapter.setVerifyPayoutResult(reference, {
      status: 'success',
      amount: AMOUNT,
    });
    await ctx.paymentsService.pollStaleWithdrawalTransactions();

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('completed');
  });

  it('does not stop the batch when verifyPayout throws for one transaction', async () => {
    const throwingRef = nextReference('wpoll-throw');
    const okRef = nextReference('wpoll-ok');
    await seedPendingWithdrawal(throwingRef, STALE_MINUTES);
    await seedPendingWithdrawal(okRef, STALE_MINUTES);
    jest
      .spyOn(ctx.fakeAdapter, 'verifyPayout')
      .mockImplementation(
        (reference): ReturnType<FakeAdapter['verifyPayout']> =>
          reference === throwingRef
            ? Promise.reject(new Error('simulated provider outage'))
            : Promise.resolve({ status: 'success', amount: AMOUNT }),
      );

    await ctx.paymentsService.pollStaleWithdrawalTransactions();

    const throwing = await ctx.transactionRepo.findOneByOrFail({
      reference: throwingRef,
    });
    const ok = await ctx.transactionRepo.findOneByOrFail({
      reference: okRef,
    });
    expect(throwing.status).toBe('pending');
    expect(ok.status).toBe('completed');

    jest.restoreAllMocks();
  });

  it('leaves a withdrawal pending when the provider-reported amount does not match at poll time', async () => {
    const reference = nextReference('wpoll-mismatch');
    await seedPendingWithdrawal(reference, STALE_MINUTES);
    ctx.fakeAdapter.setVerifyPayoutResult(reference, {
      status: 'success',
      amount: Money.of(1n, 'NGN'),
    });

    await ctx.paymentsService.pollStaleWithdrawalTransactions();

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('pending');
  });
});
