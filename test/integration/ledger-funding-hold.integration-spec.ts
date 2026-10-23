import { randomUUID } from 'crypto';
import { Money } from '../../src/shared/primitives/money';
import {
  LedgerTestContext,
  createLedgerTestContext,
  destroyLedgerTestContext,
  seedUserWithWallet,
} from './support/ledger-test-context';
import { assertInvariantHolds } from './support/ledger-invariant';

jest.setTimeout(120_000);

const NET = Money.of(100_000n, 'NGN');
const FEE = Money.of(1_397n, 'NGN');

describe('Ledger funding hold, refund settlement and failure', () => {
  let ctx: LedgerTestContext;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createLedgerTestContext();
  });

  afterAll(async () => {
    await destroyLedgerTestContext(ctx);
  });

  async function seedPendingFunding(): Promise<{
    walletId: string;
    userId: string;
    reference: string;
  }> {
    seq += 1;
    const { userId, walletId } = await seedUserWithWallet(ctx, {
      email: `hold-${seq}@example.com`,
      phone: `+2348${String(30_000_000 + seq).padStart(8, '0')}`,
      username: `hold_user_${seq}`,
    });
    const reference = `cliqpay-hold-${randomUUID()}`;
    await ctx.ledgerService.createPendingFundingTransaction({
      reference,
      provider: 'kora',
      providerReference: reference,
      amount: NET,
      recipientWalletId: walletId,
      metadata: { checkoutUrl: null, grossAmount: null },
    });
    return { userId, walletId, reference };
  }

  const facts = (reference: string, netAmount = NET) => ({
    reference,
    netAmount,
    providerFee: FEE,
    providerStatus: 'success' as const,
  });

  const hold = (reference: string, netAmount = NET) =>
    ctx.dataSource.transaction((manager) =>
      ctx.ledgerService.holdFundingWithinTransaction(
        manager,
        facts(reference, netAmount),
      ),
    );

  async function balanceOf(role: string): Promise<bigint> {
    const account = await ctx.accountRepo.findOneByOrFail({
      role: role as 'float',
      provider: 'kora',
      currency: 'NGN',
    });
    return account.balance;
  }

  async function assertCacheMatchesEntries(): Promise<void> {
    for (const account of await ctx.accountRepo.find()) {
      const entries = await ctx.ledgerEntryRepo.findBy({
        accountId: account.id,
      });
      const debitNormal =
        account.type === 'asset' || account.type === 'expense';
      const net = entries.reduce((sum, e) => {
        const positive = debitNormal
          ? e.direction === 'debit'
          : e.direction === 'credit';
        return positive ? sum + e.amount : sum - e.amount;
      }, 0n);
      expect(account.balance).toBe(net);
    }
  }

  async function entriesOf(transactionId: string) {
    const entries = await ctx.ledgerEntryRepo.find({
      where: { transactionId },
      relations: { account: true },
    });
    return entries.map((e) => ({
      role: e.account.role,
      direction: e.direction,
      amount: e.amount,
    }));
  }

  describe('hold', () => {
    it('posts DR float / CR suspense for the net amount plus the fee pair, and does not credit the wallet', async () => {
      const { walletId, userId, reference } = await seedPendingFunding();
      const floatBefore = await balanceOf('float');

      const result = await hold(reference);

      expect(result).not.toBeNull();
      expect(result!.userId).toBe(userId);
      expect(result!.netAmount.equals(NET)).toBe(true);

      const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(funding.status).toBe('held');
      expect(await entriesOf(funding.id)).toEqual(
        expect.arrayContaining([
          { role: 'float', direction: 'debit', amount: NET.amount },
          { role: 'suspense', direction: 'credit', amount: NET.amount },
          { role: 'fee_expense', direction: 'debit', amount: FEE.amount },
          { role: 'fee_recovery', direction: 'credit', amount: FEE.amount },
        ]),
      );
      expect(await entriesOf(funding.id)).toHaveLength(4);

      const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
      expect(wallet.balance).toBe(0n);
      expect(await balanceOf('float')).toBe(floatBefore + NET.amount);
      expect(await balanceOf('suspense')).toBeGreaterThanOrEqual(NET.amount);
      expect(funding.metadata).toMatchObject({
        grossAmount: NET.add(FEE).toJSON(),
      });

      await assertInvariantHolds(ctx.accountRepo);
      await assertCacheMatchesEntries();
    });

    it('creates the first refund attempt in the same transaction, with no ledger entries', async () => {
      const { reference } = await seedPendingFunding();

      const result = await hold(reference);

      const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
      const attempt = await ctx.transactionRepo.findOneByOrFail({
        reference: `rfd-${funding.id}-1`,
      });
      expect(result!.refundReference).toBe(`rfd-${funding.id}-1`);
      expect(attempt).toMatchObject({
        type: 'funding_refund',
        status: 'pending',
        provider: 'kora',
        providerReference: `rfd-${funding.id}-1`,
        reversesTransactionId: funding.id,
        amount: NET.amount,
        currency: 'NGN',
        senderWalletId: null,
        recipientWalletId: null,
        metadata: { attempt: 1 },
      });
      expect(await entriesOf(attempt.id)).toHaveLength(0);
    });

    it('a second hold for the same funding posts nothing and creates no second attempt', async () => {
      const { reference } = await seedPendingFunding();
      await hold(reference);
      const suspenseAfterFirst = await balanceOf('suspense');

      const second = await hold(reference);

      expect(second).toBeNull();
      expect(await balanceOf('suspense')).toBe(suspenseAfterFirst);
      const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(
        await ctx.transactionRepo.countBy({
          type: 'funding_refund',
          reversesTransactionId: funding.id,
        }),
      ).toBe(1);
    });

    it('fails a funding whose reported amount does not match the request instead of holding it', async () => {
      const { reference } = await seedPendingFunding();

      const result = await hold(reference, Money.of(5_000n, 'NGN'));

      expect(result).toBeNull();
      const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(funding.status).toBe('failed');
      expect(await entriesOf(funding.id)).toHaveLength(0);
    });

    it('does nothing for a reference that is not a pending funding', async () => {
      expect(await hold(`unknown-${randomUUID()}`)).toBeNull();
    });
  });

  describe('postFundingWithinTransaction', () => {
    it('credits the wallet inside the caller transaction exactly as postFunding does', async () => {
      const { walletId, reference } = await seedPendingFunding();

      const result = await ctx.dataSource.transaction((manager) =>
        ctx.ledgerService.postFundingWithinTransaction(
          manager,
          facts(reference),
        ),
      );

      expect(result).not.toBeNull();
      const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
      expect(wallet.balance).toBe(NET.amount);
      const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(funding.status).toBe('completed');
      await assertInvariantHolds(ctx.accountRepo);
    });
  });

  describe('settleRefund', () => {
    it('posts DR suspense / CR float, completes the attempt and marks the funding refunded', async () => {
      const { userId, reference } = await seedPendingFunding();
      const held = (await hold(reference))!;
      const floatBefore = await balanceOf('float');
      const suspenseBefore = await balanceOf('suspense');

      const result = await ctx.ledgerService.settleRefund({
        refundReference: held.refundReference,
        providerReportedAmount: NET,
      });

      expect(result).toMatchObject({
        userId,
        fundingReference: reference,
        refundReference: held.refundReference,
      });
      const attempt = await ctx.transactionRepo.findOneByOrFail({
        reference: held.refundReference,
      });
      expect(attempt.status).toBe('completed');
      expect(await entriesOf(attempt.id)).toEqual(
        expect.arrayContaining([
          { role: 'suspense', direction: 'debit', amount: NET.amount },
          { role: 'float', direction: 'credit', amount: NET.amount },
        ]),
      );
      expect(await entriesOf(attempt.id)).toHaveLength(2);
      const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(funding.status).toBe('refunded');
      expect(await balanceOf('float')).toBe(floatBefore - NET.amount);
      expect(await balanceOf('suspense')).toBe(suspenseBefore - NET.amount);

      await assertInvariantHolds(ctx.accountRepo);
      await assertCacheMatchesEntries();
    });

    it('a second settle for the same refund posts nothing', async () => {
      const { reference } = await seedPendingFunding();
      const held = (await hold(reference))!;
      const params = {
        refundReference: held.refundReference,
        providerReportedAmount: NET,
      };
      await ctx.ledgerService.settleRefund(params);
      const floatAfterFirst = await balanceOf('float');

      const second = await ctx.ledgerService.settleRefund(params);

      expect(second).toBeNull();
      expect(await balanceOf('float')).toBe(floatAfterFirst);
      const attempt = await ctx.transactionRepo.findOneByOrFail({
        reference: held.refundReference,
      });
      expect(await entriesOf(attempt.id)).toHaveLength(2);
    });

    it('leaves the attempt pending when the provider-reported amount differs', async () => {
      const { reference } = await seedPendingFunding();
      const held = (await hold(reference))!;

      const result = await ctx.ledgerService.settleRefund({
        refundReference: held.refundReference,
        providerReportedAmount: Money.of(NET.amount + 1n, 'NGN'),
      });

      expect(result).toBeNull();
      const attempt = await ctx.transactionRepo.findOneByOrFail({
        reference: held.refundReference,
      });
      expect(attempt.status).toBe('pending');
      const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(funding.status).toBe('held');
    });

    it('ignores a reference that is not a refund attempt', async () => {
      const { reference } = await seedPendingFunding();

      expect(
        await ctx.ledgerService.settleRefund({
          refundReference: reference,
          providerReportedAmount: NET,
        }),
      ).toBeNull();
      expect(
        await ctx.ledgerService.settleRefund({
          refundReference: `rfd-unknown-${randomUUID()}`,
          providerReportedAmount: NET,
        }),
      ).toBeNull();
    });
  });

  describe('failRefund', () => {
    it('fails the attempt with its reason, posts nothing and leaves the funding held', async () => {
      const { reference } = await seedPendingFunding();
      const held = (await hold(reference))!;
      const suspenseBefore = await balanceOf('suspense');
      const floatBefore = await balanceOf('float');

      const result = await ctx.ledgerService.failRefund({
        refundReference: held.refundReference,
        reason: 'insufficient balance',
      });

      expect(result).toMatchObject({
        fundingReference: reference,
        attempt: 1,
      });
      const attempt = await ctx.transactionRepo.findOneByOrFail({
        reference: held.refundReference,
      });
      expect(attempt.status).toBe('failed');
      expect(attempt.metadata).toMatchObject({
        attempt: 1,
        failureReason: 'insufficient balance',
      });
      expect(await entriesOf(attempt.id)).toHaveLength(0);
      const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(funding.status).toBe('held');
      expect(await balanceOf('suspense')).toBe(suspenseBefore);
      expect(await balanceOf('float')).toBe(floatBefore);
      await assertInvariantHolds(ctx.accountRepo);
    });

    it('a second failure for the same attempt, or a failure of a completed one, changes nothing', async () => {
      const { reference } = await seedPendingFunding();
      const held = (await hold(reference))!;
      await ctx.ledgerService.failRefund({
        refundReference: held.refundReference,
        reason: 'first',
      });

      expect(
        await ctx.ledgerService.failRefund({
          refundReference: held.refundReference,
          reason: 'second',
        }),
      ).toBeNull();

      const other = await seedPendingFunding();
      const heldOther = (await hold(other.reference))!;
      await ctx.ledgerService.settleRefund({
        refundReference: heldOther.refundReference,
        providerReportedAmount: NET,
      });
      expect(
        await ctx.ledgerService.failRefund({
          refundReference: heldOther.refundReference,
          reason: 'late',
        }),
      ).toBeNull();
      const attempt = await ctx.transactionRepo.findOneByOrFail({
        reference: heldOther.refundReference,
      });
      expect(attempt.status).toBe('completed');
    });
  });

  describe('startRefundAttempt and retries', () => {
    it('creates the next attempt after a failure and a success on it settles the funding once', async () => {
      const { reference } = await seedPendingFunding();
      const held = (await hold(reference))!;
      await ctx.ledgerService.failRefund({
        refundReference: held.refundReference,
        reason: 'rejected',
      });

      const next = await ctx.ledgerService.startRefundAttempt(
        held.fundingTransactionId,
      );

      expect(next).toMatchObject({
        refundReference: `rfd-${held.fundingTransactionId}-2`,
        attempt: 2,
      });
      const settled = await ctx.ledgerService.settleRefund({
        refundReference: next!.refundReference,
        providerReportedAmount: NET,
      });
      expect(settled).not.toBeNull();
      const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(funding.status).toBe('refunded');
      await assertInvariantHolds(ctx.accountRepo);
      await assertCacheMatchesEntries();
    });

    it('refuses a new attempt while one is pending, or when the funding is not held', async () => {
      const { reference } = await seedPendingFunding();
      const held = (await hold(reference))!;

      expect(
        await ctx.ledgerService.startRefundAttempt(held.fundingTransactionId),
      ).toBeNull();

      await ctx.ledgerService.settleRefund({
        refundReference: held.refundReference,
        providerReportedAmount: NET,
      });
      expect(
        await ctx.ledgerService.startRefundAttempt(held.fundingTransactionId),
      ).toBeNull();
    });

    it('settles a late success on an attempt already marked failed, and supersedes the pending retry', async () => {
      const { reference } = await seedPendingFunding();
      const held = (await hold(reference))!;
      await ctx.ledgerService.failRefund({
        refundReference: held.refundReference,
        reason: 'timed out',
      });
      const retry = (await ctx.ledgerService.startRefundAttempt(
        held.fundingTransactionId,
      ))!;

      const result = await ctx.ledgerService.settleRefund({
        refundReference: held.refundReference,
        providerReportedAmount: NET,
      });

      expect(result).not.toBeNull();
      const first = await ctx.transactionRepo.findOneByOrFail({
        reference: held.refundReference,
      });
      const second = await ctx.transactionRepo.findOneByOrFail({
        reference: retry.refundReference,
      });
      expect(first.status).toBe('completed');
      expect(second.status).toBe('failed');
      expect(second.metadata).toMatchObject({ failureReason: 'superseded' });
      expect(
        await ctx.ledgerService.settleRefund({
          refundReference: retry.refundReference,
          providerReportedAmount: NET,
        }),
      ).toBeNull();
      await assertInvariantHolds(ctx.accountRepo);
    });
  });
});
