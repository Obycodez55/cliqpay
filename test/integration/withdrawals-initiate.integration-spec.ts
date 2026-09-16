import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  fundWallet,
  seedBankAccount,
  seedWithdrawalUser,
} from './support/withdrawals-test-context';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface InitiateWithdrawalBody {
  bankAccountId: string;
  amount: number;
  reference: string;
  pin: string;
}

describe('POST /withdrawals', () => {
  let ctx: WithdrawalsTestContext;
  let jwtService: JwtService;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext({ providerFee: 3_000 });
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  function nextIdentity(prefix: string) {
    idSeq += 1;
    const n = idSeq;
    return {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348044${String(300_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
    };
  }

  async function seedFundedSenderWithBankAccount(
    overrides: { balanceMinor?: bigint; pin?: string } = {},
  ) {
    const identity = nextIdentity('withdraw');
    const { userId, walletId } = await seedWithdrawalUser(ctx, {
      ...identity,
      pin: overrides.pin,
    });
    await fundWallet(ctx, {
      reference: `cliqpay-fund-${userId}`,
      walletId,
      netAmountMinor: overrides.balanceMinor ?? 5_000_000n,
    });
    const bankAccount = await seedBankAccount(ctx, {
      userId,
      accountNumber: `000000${String(idSeq).padStart(4, '0')}`,
    });
    return { userId, walletId, bankAccount };
  }

  function initiate(token: string, body: Partial<InitiateWithdrawalBody>) {
    return request(ctx.app.getHttpServer())
      .post('/withdrawals')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('rejects an unauthenticated request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/withdrawals')
      .send({})
      .expect(401);
  });

  it('posts a balanced 5-leg withdrawal — wallet debited, float/fee_income/fee_expense/fee_recovery updated, transaction pending', async () => {
    const sender = await seedFundedSenderWithBankAccount();
    const floatBefore = await ctx.accountRepo.findOneByOrFail({
      role: 'float',
      provider: 'kora',
      currency: 'NGN',
    });
    const feeIncomeBefore = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_income',
      currency: 'NGN',
    });
    const feeExpenseBefore = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_expense',
      provider: 'kora',
      currency: 'NGN',
    });
    const feeRecoveryBefore = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_recovery',
      provider: 'kora',
      currency: 'NGN',
    });
    const reference = `cliqpay-wd-happy-${sender.userId}`;

    const res = await initiate(tokenFor(sender.userId), {
      bankAccountId: sender.bankAccount.id,
      amount: 500_000,
      reference,
      pin: '1234',
    }).expect(201);

    expect(res.body).toMatchObject({
      reference,
      amount: { amount: '500000', currency: 'NGN' },
      platformFee: { amount: '0', currency: 'NGN' },
      providerFee: { amount: '3000', currency: 'NGN' },
      status: 'pending',
    });

    const walletAccount = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });
    expect(walletAccount.balance).toBe(5_000_000n - 503_000n);

    const floatAfter = await ctx.accountRepo.findOneByOrFail({
      role: 'float',
      provider: 'kora',
      currency: 'NGN',
    });
    const feeIncomeAfter = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_income',
      currency: 'NGN',
    });
    const feeExpenseAfter = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_expense',
      provider: 'kora',
      currency: 'NGN',
    });
    const feeRecoveryAfter = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_recovery',
      provider: 'kora',
      currency: 'NGN',
    });
    expect(floatAfter.balance).toBe(floatBefore.balance + 503_000n);
    // Platform fee is 0 at launch, but the fee_income leg still always
    // posts for withdrawals (unlike a zero-fee transfer) — balance is
    // unchanged, but the ledger_entries assertion below confirms 5 legs.
    expect(feeIncomeAfter.balance).toBe(feeIncomeBefore.balance);
    expect(feeExpenseAfter.balance).toBe(feeExpenseBefore.balance + 3_000n);
    expect(feeRecoveryAfter.balance).toBe(feeRecoveryBefore.balance + 3_000n);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction).toMatchObject({
      type: 'withdrawal',
      status: 'pending',
      provider: 'kora',
      providerReference: reference,
      senderWalletId: sender.walletId,
    });
    expect(transaction.metadata).toMatchObject({
      netAmount: { amount: '500000', currency: 'NGN' },
      bankAccount: { id: sender.bankAccount.id },
    });

    const entries = await ctx.ledgerEntryRepo.find({
      where: { transactionId: transaction.id },
    });
    expect(entries).toHaveLength(5);
  });

  it('rejects an amount below the configured minimum', async () => {
    const sender = await seedFundedSenderWithBankAccount();

    await initiate(tokenFor(sender.userId), {
      bankAccountId: sender.bankAccount.id,
      amount: 9_999,
      reference: `cliqpay-wd-min-${sender.userId}`,
      pin: '1234',
    }).expect(422);
  });

  it('rejects an amount above the configured maximum', async () => {
    const sender = await seedFundedSenderWithBankAccount({
      balanceMinor: 200_000_000n,
    });

    await initiate(tokenFor(sender.userId), {
      bankAccountId: sender.bankAccount.id,
      amount: 100_000_001,
      reference: `cliqpay-wd-max-${sender.userId}`,
      pin: '1234',
    }).expect(422);
  });

  it('rejects insufficient funds with a distinct 422, without moving anything', async () => {
    const sender = await seedFundedSenderWithBankAccount({
      balanceMinor: 100_000n,
    });

    await initiate(tokenFor(sender.userId), {
      bankAccountId: sender.bankAccount.id,
      amount: 500_000,
      reference: `cliqpay-wd-insufficient-${sender.userId}`,
      pin: '1234',
    }).expect(422);

    const walletAccount = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });
    expect(walletAccount.balance).toBe(100_000n);
  });

  it("rejects a bank account that doesn't belong to the caller", async () => {
    const sender = await seedFundedSenderWithBankAccount();
    const other = await seedFundedSenderWithBankAccount();

    await initiate(tokenFor(sender.userId), {
      bankAccountId: other.bankAccount.id,
      amount: 500_000,
      reference: `cliqpay-wd-foreign-bank-${sender.userId}`,
      pin: '1234',
    }).expect(404);
  });

  it('rejects a wrong PIN with 401, without moving anything', async () => {
    const sender = await seedFundedSenderWithBankAccount();

    await initiate(tokenFor(sender.userId), {
      bankAccountId: sender.bankAccount.id,
      amount: 500_000,
      reference: `cliqpay-wd-wrongpin-${sender.userId}`,
      pin: '0000',
    }).expect(401);

    const walletAccount = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });
    expect(walletAccount.balance).toBe(5_000_000n);
  });

  describe('synchronous payout rejection', () => {
    it('reverses the posted entries and returns 422 when Kora synchronously rejects the payout', async () => {
      const sender = await seedFundedSenderWithBankAccount();
      // FakeAdapter's rejection sentinel — see fake.adapter.ts.
      const reference = `cliqpay-wd-reject-${sender.userId}`;

      await initiate(tokenFor(sender.userId), {
        bankAccountId: sender.bankAccount.id,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(422);

      const walletAccount = await ctx.accountRepo.findOneByOrFail({
        id: sender.walletId,
      });
      expect(walletAccount.balance).toBe(5_000_000n);

      const original = await ctx.transactionRepo.findOneByOrFail({
        reference,
      });
      expect(original.status).toBe('reversed');

      const reversal = await ctx.transactionRepo.findOneByOrFail({
        reference: `${reference}-reversal`,
      });
      expect(reversal).toMatchObject({
        type: 'withdrawal_reversal',
        status: 'completed',
        reversesTransactionId: original.id,
      });

      const reversalEntries = await ctx.ledgerEntryRepo.find({
        where: { transactionId: reversal.id },
      });
      expect(reversalEntries).toHaveLength(5);
    });
  });

  describe('ambiguous payout outcome', () => {
    // A network error or unrecognized response isn't a confirmed rejection
    // — Kora may still have received and be processing the payout. Debit-
    // first already moved money out of the wallet, so reversing here would
    // risk crediting it back while the bank transfer still lands. This must
    // stay pending, not 422/reverse like a confirmed rejection.
    it('leaves the transaction pending, without reversing, when the payout outcome is unknown', async () => {
      const sender = await seedFundedSenderWithBankAccount();
      // FakeAdapter's unknown-outcome sentinel — see fake.adapter.ts.
      const reference = `cliqpay-wd-unknown-${sender.userId}`;

      const res = await initiate(tokenFor(sender.userId), {
        bankAccountId: sender.bankAccount.id,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(201);

      expect(res.body).toMatchObject({ status: 'pending' });

      const walletAccount = await ctx.accountRepo.findOneByOrFail({
        id: sender.walletId,
      });
      expect(walletAccount.balance).toBe(5_000_000n - 503_000n);

      const transaction = await ctx.transactionRepo.findOneByOrFail({
        reference,
      });
      expect(transaction.status).toBe('pending');

      const reversal = await ctx.transactionRepo.findOneBy({
        reference: `${reference}-reversal`,
      });
      expect(reversal).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('replays the original result for a matching retry, without moving money twice', async () => {
      const sender = await seedFundedSenderWithBankAccount();
      const reference = `cliqpay-wd-replay-${sender.userId}`;
      const body = {
        bankAccountId: sender.bankAccount.id,
        amount: 500_000,
        reference,
        pin: '1234',
      };

      const first = await initiate(tokenFor(sender.userId), body).expect(201);
      const second = await initiate(tokenFor(sender.userId), body).expect(201);

      expect(second.body).toEqual(first.body);
      const walletAccount = await ctx.accountRepo.findOneByOrFail({
        id: sender.walletId,
      });
      expect(walletAccount.balance).toBe(5_000_000n - 503_000n);
    });

    it('rejects a reference already used by a different sender with 409', async () => {
      const senderA = await seedFundedSenderWithBankAccount();
      const senderB = await seedFundedSenderWithBankAccount();
      const reference = `cliqpay-wd-foreign-${senderA.userId}`;

      await initiate(tokenFor(senderA.userId), {
        bankAccountId: senderA.bankAccount.id,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(201);

      await initiate(tokenFor(senderB.userId), {
        bankAccountId: senderB.bankAccount.id,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(409);
    });

    it('rejects a reference reused with a different amount with 422', async () => {
      const sender = await seedFundedSenderWithBankAccount();
      const reference = `cliqpay-wd-diverged-${sender.userId}`;

      await initiate(tokenFor(sender.userId), {
        bankAccountId: sender.bankAccount.id,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(201);

      await initiate(tokenFor(sender.userId), {
        bankAccountId: sender.bankAccount.id,
        amount: 600_000,
        reference,
        pin: '1234',
      }).expect(422);
    });

    it('rejects a reference reused for a different bank account with 422', async () => {
      const sender = await seedFundedSenderWithBankAccount();
      const secondBankAccount = await seedBankAccount(ctx, {
        userId: sender.userId,
        bankCode: '058',
        accountNumber: `1${String(idSeq).padStart(9, '0')}`,
      });
      const reference = `cliqpay-wd-diverged-bank-${sender.userId}`;

      await initiate(tokenFor(sender.userId), {
        bankAccountId: sender.bankAccount.id,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(201);

      await initiate(tokenFor(sender.userId), {
        bankAccountId: secondBankAccount.id,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(422);
    });
  });

  describe('notifications', () => {
    it('sends a withdrawal_initiated email once the payout is accepted', async () => {
      const sender = await seedFundedSenderWithBankAccount();
      const reference = `cliqpay-wd-notify-${sender.userId}`;
      const emailCountBefore = ctx.emailAdapter.sent.length;

      await initiate(tokenFor(sender.userId), {
        bankAccountId: sender.bankAccount.id,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(201);

      await waitFor(() => ctx.emailAdapter.sent.length >= emailCountBefore + 1);
      const newEmails = ctx.emailAdapter.sent.slice(emailCountBefore);
      expect(newEmails.some((m) => m.subject.includes('withdrawal'))).toBe(
        true,
      );
    });
  });
});
