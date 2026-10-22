import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { Money } from '../../src/shared/primitives/money';
import { KycTier } from '../../src/modules/users/users.service';
import {
  DailyLimitExceededException,
  KycVerificationRequiredException,
} from '../../src/modules/kyc/internal/errors';
import { holdUserLock, trackSettled, waitBriefly } from './support/user-lock';
import { startOfDay } from '../../src/modules/kyc/internal/day-start';
import { WithdrawalPayoutFailedException } from '../../src/modules/withdrawals/internal/errors';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  fundWallet,
  seedBankAccount,
  seedWithdrawalUser,
} from './support/withdrawals-test-context';

jest.setTimeout(180_000);

// Seeded tier1 daily limit (CreateTierLimits migration), in kobo.
const TIER1_LIMIT = 5_000_000;
const PROVIDER_FEE = 3_000;

describe('Daily debit limit', () => {
  let ctx: WithdrawalsTestContext;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext({ providerFee: PROVIDER_FEE });
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  async function seedUser(
    prefix: string,
    tier: KycTier = 'tier1',
    balanceMinor = 50_000_000n,
  ) {
    seq += 1;
    const n = seq;
    const { userId, walletId } = await seedWithdrawalUser(ctx, {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348077${String(100_000 + n).padStart(6, '0')}`,
      username: `${prefix}_limit_${n}`,
      kycTier: tier,
    });
    if (balanceMinor > 0n) {
      await fundWallet(ctx, {
        reference: `cliqpay-limit-fund-${randomUUID()}`,
        walletId,
        netAmountMinor: balanceMinor,
      });
    }
    const bankAccount = await seedBankAccount(ctx, {
      userId,
      accountNumber: `0077${String(100_000 + n).padStart(6, '0')}`,
    });
    return { userId, walletId, bankAccountId: bankAccount.id };
  }

  function transfer(
    senderId: string,
    recipientUserId: string,
    amount: number,
    reference = `cliqpay-limit-xfer-${randomUUID()}`,
  ) {
    return ctx.transfersService.sendMoney(senderId, {
      recipientUserId,
      amount,
      reference,
      pin: '1234',
    });
  }

  function withdraw(
    userId: string,
    bankAccountId: string,
    amount: number,
    reference = `cliqpay-limit-wd-${randomUUID()}`,
  ) {
    return ctx.withdrawalsService.initiateWithdrawal(userId, {
      bankAccountId,
      amount,
      reference,
      pin: '1234',
    });
  }

  async function debitedToday(userId: string): Promise<bigint> {
    const debited = await ctx.dataSource.transaction((manager) =>
      ctx.ledgerService.getDebitedSince(
        manager,
        userId,
        startOfDay(new Date(), 'Africa/Lagos'),
      ),
    );
    return debited.amount;
  }

  async function walletBalance(walletId: string): Promise<bigint> {
    return (await ctx.accountRepo.findOneByOrFail({ id: walletId })).balance;
  }

  describe('limit-check query plans', () => {
    async function plan(sql: string, params: unknown[]): Promise<string> {
      return ctx.dataSource.transaction(async (manager) => {
        // A near-empty table would otherwise favour a seq scan whatever the indexes.
        await manager.query('SET LOCAL enable_seqscan = off');
        const rows = await manager.query<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN ${sql}`,
          params,
        );
        return rows.map((row) => row['QUERY PLAN']).join('\n');
      });
    }

    it('reads the debited sum through the sender-wallet index', async () => {
      const result = await plan(
        `SELECT COALESCE(SUM(amount), 0) FROM transactions
         WHERE sender_wallet_id = $1
           AND type IN ('p2p_transfer', 'withdrawal')
           AND status IN ('pending', 'completed')
           AND created_at >= $2`,
        [randomUUID(), new Date()],
      );

      expect(result).toContain('IDX_transactions_sender_wallet_created_at');
    });

    it('reads pending funding through the partial recipient index', async () => {
      const result = await plan(
        `SELECT SUM(t.amount) FROM transactions t
         WHERE t.recipient_wallet_id = $1
           AND t.type = 'funding'
           AND t.status = 'pending'`,
        [randomUUID()],
      );

      expect(result).toContain('IDX_transactions_pending_funding_recipient');
    });
  });

  describe('ledger.getDebitedSince', () => {
    it('sums the principal of transfers and withdrawals, not fees', async () => {
      const sender = await seedUser('sum');
      const recipient = await seedUser('sumrcpt', 'tier1', 0n);

      await transfer(sender.userId, recipient.userId, 100_000);
      await withdraw(sender.userId, sender.bankAccountId, 200_000);

      expect(await debitedToday(sender.userId)).toBe(300_000n);
    });

    it('does not count money the user received or another user sent', async () => {
      const sender = await seedUser('other');
      const recipient = await seedUser('otherrcpt', 'tier1', 0n);

      await transfer(sender.userId, recipient.userId, 100_000);

      expect(await debitedToday(recipient.userId)).toBe(0n);
    });

    it('counts a withdrawal rejected synchronously by the provider as zero', async () => {
      const sender = await seedUser('syncrej');
      const reference = `cliqpay-limit-wd-reject-${randomUUID()}`;

      await expect(
        withdraw(sender.userId, sender.bankAccountId, 500_000, reference),
      ).rejects.toBeInstanceOf(WithdrawalPayoutFailedException);

      const original = await ctx.transactionRepo.findOneByOrFail({ reference });
      expect(original.status).toBe('reversed');
      expect(await debitedToday(sender.userId)).toBe(0n);
    });

    it('counts a pending withdrawal, then zero once the payout-failure path reverses it', async () => {
      const sender = await seedUser('webhookrev');
      const reference = `cliqpay-limit-wd-${randomUUID()}`;
      await withdraw(sender.userId, sender.bankAccountId, 500_000, reference);
      expect(await debitedToday(sender.userId)).toBe(500_000n);

      await ctx.ledgerService.reverseWithdrawal({
        reference,
        reason: 'Beneficiary account closed',
      });

      const original = await ctx.transactionRepo.findOneByOrFail({ reference });
      const reversal = await ctx.transactionRepo.findOneByOrFail({
        reference: `${reference}-reversal`,
      });
      expect(original.status).toBe('reversed');
      expect(reversal.type).toBe('withdrawal_reversal');
      expect(await debitedToday(sender.userId)).toBe(0n);
    });

    it('counts a completed withdrawal', async () => {
      const sender = await seedUser('completed');
      const reference = `cliqpay-limit-wd-${randomUUID()}`;
      await withdraw(sender.userId, sender.bankAccountId, 500_000, reference);

      await ctx.ledgerService.completeWithdrawal({
        reference,
        providerReportedAmount: Money.of(500_000, 'NGN'),
      });

      expect(await debitedToday(sender.userId)).toBe(500_000n);
    });

    it('ignores a transaction whose status is failed', async () => {
      const sender = await seedUser('failed');
      const recipient = await seedUser('failedrcpt', 'tier1', 0n);
      const reference = `cliqpay-limit-xfer-${randomUUID()}`;
      await transfer(sender.userId, recipient.userId, 100_000, reference);

      await ctx.transactionRepo.update({ reference }, { status: 'failed' });

      expect(await debitedToday(sender.userId)).toBe(0n);
    });

    it('includes a transaction created exactly at the window start and excludes one just before it', async () => {
      const sender = await seedUser('window');
      const recipient = await seedUser('windowrcpt', 'tier1', 0n);
      const dayStart = startOfDay(new Date(), 'Africa/Lagos');
      const atStart = `cliqpay-limit-xfer-${randomUUID()}`;
      const before = `cliqpay-limit-xfer-${randomUUID()}`;
      await transfer(sender.userId, recipient.userId, 100_000, atStart);
      await transfer(sender.userId, recipient.userId, 200_000, before);

      await ctx.transactionRepo.update(
        { reference: atStart },
        {
          createdAt: dayStart,
        },
      );
      await ctx.transactionRepo.update(
        { reference: before },
        {
          createdAt: new Date(dayStart.getTime() - 1),
        },
      );

      expect(await debitedToday(sender.userId)).toBe(100_000n);
    });
  });

  describe('enforcement', () => {
    it('rejects a transfer over the limit and posts nothing', async () => {
      const sender = await seedUser('over');
      const recipient = await seedUser('overrcpt', 'tier1', 0n);
      const reference = `cliqpay-limit-xfer-${randomUUID()}`;
      const balanceBefore = await walletBalance(sender.walletId);

      const error = await transfer(
        sender.userId,
        recipient.userId,
        TIER1_LIMIT + 1,
        reference,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DailyLimitExceededException);
      expect((error as DailyLimitExceededException).details).toEqual({
        dailyLimit: { amount: String(TIER1_LIMIT), currency: 'NGN' },
        remaining: { amount: String(TIER1_LIMIT), currency: 'NGN' },
      });
      expect(await ctx.transactionRepo.findOneBy({ reference })).toBeNull();
      expect(await walletBalance(sender.walletId)).toBe(balanceBefore);
      expect(await walletBalance(recipient.walletId)).toBe(0n);
    });

    it('allows a transfer exactly at the limit, then rejects one more kobo', async () => {
      const sender = await seedUser('exact');
      const recipient = await seedUser('exactrcpt', 'tier1', 0n);

      await transfer(sender.userId, recipient.userId, TIER1_LIMIT);

      await expect(
        transfer(sender.userId, recipient.userId, 10_000),
      ).rejects.toBeInstanceOf(DailyLimitExceededException);
    });

    it('blocks a withdrawal once transfers have used the allowance, and reports what is left', async () => {
      const sender = await seedUser('aggregate');
      const recipient = await seedUser('aggregatercpt', 'tier1', 0n);
      await transfer(sender.userId, recipient.userId, 3_000_000);
      const reference = `cliqpay-limit-wd-${randomUUID()}`;
      const balanceBefore = await walletBalance(sender.walletId);

      const error = await withdraw(
        sender.userId,
        sender.bankAccountId,
        2_500_000,
        reference,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DailyLimitExceededException);
      expect((error as DailyLimitExceededException).details).toMatchObject({
        remaining: { amount: '2000000', currency: 'NGN' },
      });
      expect(await ctx.transactionRepo.findOneBy({ reference })).toBeNull();
      expect(await walletBalance(sender.walletId)).toBe(balanceBefore);

      await withdraw(sender.userId, sender.bankAccountId, 2_000_000);
    });

    it('asks a tier 0 user to verify instead of quoting a ₦0 limit', async () => {
      const sender = await seedUser('tier0', 'tier0');
      const recipient = await seedUser('tier0rcpt', 'tier1', 0n);

      await expect(
        transfer(sender.userId, recipient.userId, 10_000),
      ).rejects.toBeInstanceOf(KycVerificationRequiredException);
      await expect(
        withdraw(sender.userId, sender.bankAccountId, 10_000),
      ).rejects.toBeInstanceOf(KycVerificationRequiredException);
    });

    it('fails closed when the tier has no limit row', async () => {
      const sender = await seedUser('norow', 'tier2');
      const recipient = await seedUser('norowrcpt', 'tier1', 0n);
      await ctx.dataSource.query(
        `DELETE FROM tier_limits WHERE tier = 'tier2'`,
      );

      try {
        await expect(
          transfer(sender.userId, recipient.userId, 10_000),
        ).rejects.toMatchObject({ status: 500 });
        expect(await debitedToday(sender.userId)).toBe(0n);
      } finally {
        await ctx.dataSource.query(
          `INSERT INTO tier_limits (tier, currency, daily_debit_limit_minor, balance_cap_minor)
           VALUES ('tier2', 'NGN', 20000000, 50000000)`,
        );
      }
    });

    it('replays a transfer at the limit without consuming or tripping the allowance', async () => {
      const sender = await seedUser('replayxfer');
      const recipient = await seedUser('replayxferrcpt', 'tier1', 0n);
      const reference = `cliqpay-limit-xfer-${randomUUID()}`;
      const first = await transfer(
        sender.userId,
        recipient.userId,
        TIER1_LIMIT,
        reference,
      );

      const replay = await transfer(
        sender.userId,
        recipient.userId,
        TIER1_LIMIT,
        reference,
      );

      expect(replay).toEqual(first);
      expect(await debitedToday(sender.userId)).toBe(BigInt(TIER1_LIMIT));
      expect(
        await ctx.transactionRepo.countBy({ reference, type: 'p2p_transfer' }),
      ).toBe(1);
    });

    it('replays a withdrawal at the limit without consuming or tripping the allowance', async () => {
      const sender = await seedUser('replaywd');
      const reference = `cliqpay-limit-wd-${randomUUID()}`;
      const first = await withdraw(
        sender.userId,
        sender.bankAccountId,
        TIER1_LIMIT,
        reference,
      );

      const replay = await withdraw(
        sender.userId,
        sender.bankAccountId,
        TIER1_LIMIT,
        reference,
      );

      expect(replay).toEqual(first);
      expect(await debitedToday(sender.userId)).toBe(BigInt(TIER1_LIMIT));
    });

    it('frees the allowance when a withdrawal is reversed', async () => {
      const sender = await seedUser('free');
      const recipient = await seedUser('freercpt', 'tier1', 0n);
      const reference = `cliqpay-limit-wd-${randomUUID()}`;
      await withdraw(
        sender.userId,
        sender.bankAccountId,
        TIER1_LIMIT,
        reference,
      );
      await expect(
        transfer(sender.userId, recipient.userId, 10_000),
      ).rejects.toBeInstanceOf(DailyLimitExceededException);

      await ctx.ledgerService.reverseWithdrawal({
        reference,
        reason: 'Beneficiary account closed',
      });

      await transfer(sender.userId, recipient.userId, TIER1_LIMIT);
    });

    it('frees the allowance when the provider rejects the payout synchronously', async () => {
      const sender = await seedUser('syncfree');
      const recipient = await seedUser('syncfreercpt', 'tier1', 0n);

      await expect(
        withdraw(
          sender.userId,
          sender.bankAccountId,
          TIER1_LIMIT,
          `cliqpay-limit-wd-reject-${randomUUID()}`,
        ),
      ).rejects.toBeInstanceOf(WithdrawalPayoutFailedException);

      await transfer(sender.userId, recipient.userId, TIER1_LIMIT);
    });
  });

  describe('concurrency', () => {
    const settle = (promises: Promise<unknown>[]) =>
      Promise.allSettled(promises);

    function fulfilled(results: PromiseSettledResult<unknown>[]) {
      return results.filter((r) => r.status === 'fulfilled').length;
    }

    function limitRejections(results: PromiseSettledResult<unknown>[]) {
      return results.filter(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof DailyLimitExceededException,
      ).length;
    }

    it('commits exactly the transfers that fit when their combined amount exceeds the allowance', async () => {
      for (let i = 0; i < 3; i += 1) {
        const sender = await seedUser(`burst${i}`);
        const recipient = await seedUser(`burst${i}rcpt`, 'tier1', 0n);
        const balanceBefore = await walletBalance(sender.walletId);

        const results = await settle(
          Array.from({ length: 8 }, () =>
            transfer(sender.userId, recipient.userId, 1_000_000),
          ),
        );

        expect(fulfilled(results)).toBe(5);
        expect(limitRejections(results)).toBe(3);
        expect(await debitedToday(sender.userId)).toBe(5_000_000n);
        expect(await walletBalance(sender.walletId)).toBe(
          balanceBefore - 5_000_000n,
        );
        expect(await walletBalance(recipient.walletId)).toBe(5_000_000n);
      }
    });

    it('never lets two requests that are each under the limit both succeed when jointly over it', async () => {
      for (let i = 0; i < 5; i += 1) {
        const sender = await seedUser(`pair${i}`);
        const recipient = await seedUser(`pair${i}rcpt`, 'tier1', 0n);

        const results = await settle([
          transfer(sender.userId, recipient.userId, 3_000_000),
          transfer(sender.userId, recipient.userId, 3_000_000),
        ]);

        expect(fulfilled(results)).toBe(1);
        expect(limitRejections(results)).toBe(1);
        expect(await debitedToday(sender.userId)).toBe(3_000_000n);
      }
    });

    it('shares one allowance across a mixed burst of transfers and withdrawals', async () => {
      for (let i = 0; i < 5; i += 1) {
        const sender = await seedUser(`mixed${i}`);
        const recipient = await seedUser(`mixed${i}rcpt`, 'tier1', 0n);

        const results = await settle([
          ...Array.from({ length: 4 }, () =>
            transfer(sender.userId, recipient.userId, 1_200_000),
          ),
          ...Array.from({ length: 4 }, () =>
            withdraw(sender.userId, sender.bankAccountId, 1_200_000),
          ),
        ]);

        expect(fulfilled(results)).toBe(4);
        expect(limitRejections(results)).toBe(4);
        expect(await debitedToday(sender.userId)).toBe(4_800_000n);
      }
    });

    it('holds a second limit check back until the first transaction commits', async () => {
      const sender = await seedUser('barrier');
      const recipient = await seedUser('barrierrcpt', 'tier1', 0n);
      const reader = (m: EntityManager, since: Date) =>
        ctx.ledgerService.getDebitedSince(m, sender.userId, since);
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstHoldsLock!: () => void;
      const firstChecked = new Promise<void>((resolve) => {
        firstHoldsLock = resolve;
      });

      const first = ctx.dataSource.transaction(async (manager) => {
        await ctx.kycService.checkAndReserveLimit(
          manager,
          sender.userId,
          Money.of(3_000_000, 'NGN'),
          reader,
        );
        firstHoldsLock();
        await firstMayCommit;
        await ctx.ledgerService.postTransferWithinTransaction(manager, {
          reference: `cliqpay-limit-xfer-${randomUUID()}`,
          senderWalletId: sender.walletId,
          recipientWalletId: recipient.walletId,
          amount: Money.of(3_000_000, 'NGN'),
          platformFee: Money.zero('NGN'),
        });
      });
      await firstChecked;

      let secondSettled = false;
      const second = ctx.dataSource
        .transaction((manager) =>
          ctx.kycService.checkAndReserveLimit(
            manager,
            sender.userId,
            Money.of(3_000_000, 'NGN'),
            reader,
          ),
        )
        .finally(() => {
          secondSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(secondSettled).toBe(false);

      releaseFirst();
      await first;
      await expect(second).rejects.toBeInstanceOf(DailyLimitExceededException);
    });

    it.each(['transfer', 'withdrawal'] as const)(
      'holds a %s back while another transaction holds the user lock',
      async (kind) => {
        const sender = await seedUser(`lock${kind}`);
        const recipient = await seedUser(`lock${kind}rcpt`, 'tier1', 0n);
        const held = await holdUserLock(ctx.dataSource, sender.userId);

        const call = trackSettled<unknown>(
          kind === 'transfer'
            ? transfer(sender.userId, recipient.userId, 1_000_000)
            : withdraw(sender.userId, sender.bankAccountId, 1_000_000),
        );
        await waitBriefly();
        const settledWhileHeld = call.isSettled();

        await held.release();
        await call.promise;
        expect(settledWhileHeld).toBe(false);
      },
    );

    it('answers concurrent duplicates of one reference with the original result, not a limit error', async () => {
      const sender = await seedUser('dupes');
      const recipient = await seedUser('dupesrcpt', 'tier1', 0n);
      const reference = `cliqpay-limit-xfer-${randomUUID()}`;

      const results = await settle(
        Array.from({ length: 4 }, () =>
          transfer(sender.userId, recipient.userId, TIER1_LIMIT, reference),
        ),
      );

      expect(fulfilled(results)).toBe(4);
      expect(await debitedToday(sender.userId)).toBe(BigInt(TIER1_LIMIT));
      expect(
        await ctx.transactionRepo.countBy({ reference, type: 'p2p_transfer' }),
      ).toBe(1);
    });
  });
});
