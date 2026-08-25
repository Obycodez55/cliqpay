import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { WithdrawalHistoryItemDto } from '../../src/modules/withdrawals/dto/withdrawal-history-item.dto';
import { PaginatedResult } from '../../src/common/interfaces/paginated-result.interface';
import { Money } from '../../src/shared/primitives/money';
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

type HistoryResponse = PaginatedResult<WithdrawalHistoryItemDto>;

describe('GET /withdrawals', () => {
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
      phone: `+2348055${String(300_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
    };
  }

  async function seedFundedSenderWithBankAccount(
    overrides: { balanceMinor?: bigint } = {},
  ) {
    const identity = nextIdentity('wdhist');
    const { userId, walletId } = await seedWithdrawalUser(ctx, identity);
    await fundWallet(ctx, {
      reference: `cliqpay-wdhist-fund-${userId}`,
      walletId,
      netAmountMinor: overrides.balanceMinor ?? 5_000_000n,
    });
    const bankAccount = await seedBankAccount(ctx, {
      userId,
      accountNumber: `000000${String(idSeq).padStart(4, '0')}`,
    });
    return { userId, walletId, bankAccount };
  }

  async function initiateWithdrawal(
    userId: string,
    bankAccountId: string,
    reference: string,
    amount = 500_000,
  ) {
    return ctx.withdrawalsService.initiateWithdrawal(userId, {
      bankAccountId,
      amount,
      reference,
      pin: '1234',
    });
  }

  it('rejects an unauthenticated request', async () => {
    await request(ctx.app.getHttpServer()).get('/withdrawals').expect(401);
  });

  it('rejects a malformed cursor with 400 instead of querying the DB with it', async () => {
    const sender = await seedFundedSenderWithBankAccount();

    await request(ctx.app.getHttpServer())
      .get('/withdrawals')
      .query({ cursor: 'not-a-real-cursor' })
      .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
      .expect(400);
  });

  it("returns only the caller's own withdrawals, newest first, with bank account/fee details, and a null nextCursor once exhausted", async () => {
    const sender = await seedFundedSenderWithBankAccount();
    const other = await seedFundedSenderWithBankAccount();

    for (const amount of [100_000, 200_000, 300_000]) {
      await initiateWithdrawal(
        sender.userId,
        sender.bankAccount.id,
        `cliqpay-wdhist-basic-${sender.userId}-${amount}`,
        amount,
      );
    }
    await initiateWithdrawal(
      other.userId,
      other.bankAccount.id,
      `cliqpay-wdhist-other-${other.userId}`,
    );

    const res = await request(ctx.app.getHttpServer())
      .get('/withdrawals')
      .query({ limit: 20 })
      .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
      .expect(200);

    const body = res.body as HistoryResponse;
    expect(body.items).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((i) => i.amount.amount)).toEqual([
      '300000',
      '200000',
      '100000',
    ]);
    for (const item of body.items) {
      expect(item.status).toBe('pending');
      expect(item.providerFee).toEqual({ amount: '3000', currency: 'NGN' });
      expect(item.bankAccount).toEqual({
        bankCode: sender.bankAccount.bankCode,
        bankName: sender.bankAccount.bankName,
        accountNumber: sender.bankAccount.accountNumber,
        accountName: sender.bankAccount.accountName,
      });
    }
    expect(body.items.every((i) => i.reference.includes(sender.userId))).toBe(
      true,
    );
  });

  it('walks multiple pages via nextCursor with no duplicates or gaps', async () => {
    const sender = await seedFundedSenderWithBankAccount({
      balanceMinor: 20_000_000n,
    });

    const totalRows = 7;
    for (let i = 0; i < totalRows; i++) {
      await initiateWithdrawal(
        sender.userId,
        sender.bankAccount.id,
        `cliqpay-wdhist-paged-${sender.userId}-${i}`,
        10_000 + i,
      );
    }

    const limit = 3;
    const seenReferences: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const res = await request(ctx.app.getHttpServer())
        .get('/withdrawals')
        .query(cursor ? { limit, cursor } : { limit })
        .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
        .expect(200);
      const body = res.body as HistoryResponse;

      expect(body.items.length).toBeLessThanOrEqual(limit);
      seenReferences.push(...body.items.map((i) => i.reference));
      cursor = body.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(totalRows + 1);
    } while (cursor);

    expect(pages).toBe(Math.ceil(totalRows / limit));
    expect(seenReferences).toHaveLength(totalRows);
    expect(new Set(seenReferences).size).toBe(totalRows);
  });

  it('does not drop rows sharing a millisecond across a page boundary', async () => {
    const sender = await seedFundedSenderWithBankAccount();

    const rowCount = 6;
    const sameMillisecond = new Date('2026-01-01T00:00:00.500Z');
    for (let i = 0; i < rowCount; i++) {
      const transaction = await ctx.transactionRepo.save(
        ctx.transactionRepo.create({
          reference: `cliqpay-wdhist-collision-${sender.userId}-${i}`,
          provider: 'kora',
          providerReference: `cliqpay-wdhist-collision-${sender.userId}-${i}`,
          type: 'withdrawal',
          status: 'pending',
          amount: BigInt(10_000 + i),
          currency: 'NGN',
          senderWalletId: sender.walletId,
          metadata: {
            bankAccount: {
              id: sender.bankAccount.id,
              bankCode: sender.bankAccount.bankCode,
              bankName: sender.bankAccount.bankName,
              accountNumber: sender.bankAccount.accountNumber,
              accountName: sender.bankAccount.accountName,
            },
            netAmount: { amount: String(10_000 + i), currency: 'NGN' },
            platformFee: { amount: '0', currency: 'NGN' },
            providerFee: { amount: '3000', currency: 'NGN' },
          },
        }),
      );
      await ctx.dataSource.query(
        `UPDATE transactions SET created_at = $1::timestamptz + ($2 || ' microseconds')::interval WHERE id = $3`,
        [sameMillisecond.toISOString(), i, transaction.id],
      );
    }

    const limit = 2;
    const seenReferences: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const res = await request(ctx.app.getHttpServer())
        .get('/withdrawals')
        .query(cursor ? { limit, cursor } : { limit })
        .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
        .expect(200);
      const body = res.body as HistoryResponse;

      seenReferences.push(...body.items.map((i) => i.reference));
      cursor = body.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(rowCount + 1);
    } while (cursor);

    expect(new Set(seenReferences).size).toBe(rowCount);
  });

  it('reflects pending, completed, and reversed status correctly', async () => {
    const sender = await seedFundedSenderWithBankAccount();

    const pendingReference = `cliqpay-wdhist-status-pending-${sender.userId}`;
    await initiateWithdrawal(
      sender.userId,
      sender.bankAccount.id,
      pendingReference,
    );

    const completedReference = `cliqpay-wdhist-status-completed-${sender.userId}`;
    const completed = await initiateWithdrawal(
      sender.userId,
      sender.bankAccount.id,
      completedReference,
    );
    const completeResult = await ctx.ledgerService.completeWithdrawal({
      reference: completedReference,
      providerReportedAmount: Money.of(
        BigInt(completed.amount.amount),
        completed.amount.currency,
      ),
    });
    expect(completeResult).not.toBeNull();

    // A reference containing "reject" makes FakeAdapter synchronously
    // reject the payout, which WithdrawalsService.initiateWithdrawal
    // reverses in the same call (see withdrawals-initiate.integration-spec.ts) —
    // the resulting 'reversed' status is what this endpoint must surface.
    const reversedReference = `cliqpay-wdhist-status-reject-${sender.userId}`;
    await expect(
      initiateWithdrawal(
        sender.userId,
        sender.bankAccount.id,
        reversedReference,
      ),
    ).rejects.toThrow();

    const res = await request(ctx.app.getHttpServer())
      .get('/withdrawals')
      .query({ limit: 20 })
      .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
      .expect(200);

    const body = res.body as HistoryResponse;
    const byReference = new Map(body.items.map((i) => [i.reference, i]));
    expect(byReference.get(pendingReference)?.status).toBe('pending');
    expect(byReference.get(completedReference)?.status).toBe('completed');
    expect(byReference.get(reversedReference)?.status).toBe('reversed');
  });
});
