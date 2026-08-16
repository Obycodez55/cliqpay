import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { TransactionHistoryItemDto } from '../../src/modules/ledger/dto/transaction-history-item.dto';
import { PaginatedResult } from '../../src/common/interfaces/paginated-result.interface';
import { Money } from '../../src/shared/primitives/money';
import {
  LedgerTestContext,
  createLedgerTestContext,
  destroyLedgerTestContext,
  seedCompletedFunding,
  seedUserWithWallet,
} from './support/ledger-test-context';

jest.setTimeout(120_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

type HistoryResponse = PaginatedResult<TransactionHistoryItemDto>;

describe('GET /wallet/transactions', () => {
  let ctx: LedgerTestContext;
  let jwtService: JwtService;

  beforeAll(async () => {
    ctx = await createLedgerTestContext();
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyLedgerTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  it('rejects an unauthenticated request', async () => {
    await request(ctx.app.getHttpServer())
      .get('/wallet/transactions')
      .expect(401);
  });

  it('rejects a malformed cursor with 400 instead of querying the DB with it', async () => {
    const { userId } = await seedUserWithWallet(ctx, {
      email: 'history-badcursor@example.com',
      phone: '+2348022220001',
      username: 'history_badcursor_user',
    });

    await request(ctx.app.getHttpServer())
      .get('/wallet/transactions')
      .query({ cursor: 'not-a-real-cursor' })
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .expect(400);
  });

  it("returns only the caller's own entries, newest first, with a null nextCursor once exhausted", async () => {
    const { userId, walletId } = await seedUserWithWallet(ctx, {
      email: 'history-basic@example.com',
      phone: '+2348022220002',
      username: 'history_basic_user',
    });
    const { walletId: otherWalletId } = await seedUserWithWallet(ctx, {
      email: 'history-other@example.com',
      phone: '+2348022220003',
      username: 'history_other_user',
    });

    for (const amount of [10_000n, 20_000n, 30_000n]) {
      await seedCompletedFunding(ctx, {
        walletId,
        reference: `cliqpay-history-basic-${amount}`,
        netAmountMinor: amount,
      });
    }
    await seedCompletedFunding(ctx, {
      walletId: otherWalletId,
      reference: 'cliqpay-history-other-1',
      netAmountMinor: 99_999n,
    });

    const res = await request(ctx.app.getHttpServer())
      .get('/wallet/transactions')
      .query({ limit: 20 })
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .expect(200);

    const body = res.body as HistoryResponse;
    expect(body.items).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((i) => i.amount.amount)).toEqual([
      '30000',
      '20000',
      '10000',
    ]);
    for (const item of body.items) {
      expect(item.direction).toBe('credit');
      expect(item.type).toBe('funding');
      expect(item.status).toBe('completed');
      expect(item.counterparty).toBeNull();
    }
  });

  it('walks multiple pages via nextCursor with no duplicates or gaps', async () => {
    const { userId, walletId } = await seedUserWithWallet(ctx, {
      email: 'history-paged@example.com',
      phone: '+2348022220004',
      username: 'history_paged_user',
    });

    const totalRows = 7;
    for (let i = 0; i < totalRows; i++) {
      await seedCompletedFunding(ctx, {
        walletId,
        reference: `cliqpay-history-paged-${i}`,
        netAmountMinor: BigInt(1000 + i),
      });
    }

    const limit = 3;
    const seenIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const res = await request(ctx.app.getHttpServer())
        .get('/wallet/transactions')
        .query(cursor ? { limit, cursor } : { limit })
        .set('Authorization', `Bearer ${tokenFor(userId)}`)
        .expect(200);
      const body = res.body as HistoryResponse;

      expect(body.items.length).toBeLessThanOrEqual(limit);
      seenIds.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(Math.ceil(totalRows / limit));
    expect(seenIds).toHaveLength(totalRows);
    expect(new Set(seenIds).size).toBe(totalRows);

    const entries = await ctx.ledgerEntryRepo.find({
      where: { accountId: walletId },
    });
    expect(new Set(seenIds)).toEqual(new Set(entries.map((e) => e.id)));
  });

  it('does not drop rows sharing a millisecond across a page boundary', async () => {
    // Regression for the cursor truncating createdAt to millisecond
    // precision (JS `Date` ceiling) while Postgres stores microseconds —
    // realistic because postFundingEntries batch-inserts entries in one
    // statement, so distinct fundings can land in the same millisecond.
    // Forced explicitly here by setting created_at at INSERT time (rather
    // than seeding via postFunding then UPDATE-ing afterward) — ledger_entries
    // is append-only (docs/architecture.md §7), so the collision has to be
    // baked in at creation, not patched in after the fact.
    const { userId, walletId } = await seedUserWithWallet(ctx, {
      email: 'history-collision@example.com',
      phone: '+2348022220005',
      username: 'history_collision_user',
    });

    const rowCount = 6;
    // Same millisecond, distinct microseconds — the exact shape that broke
    // the truncated cursor.
    const sameMillisecond = new Date('2026-01-01T00:00:00.500Z');
    for (let i = 0; i < rowCount; i++) {
      const transaction = await ctx.transactionRepo.save(
        ctx.transactionRepo.create({
          reference: `cliqpay-history-collision-${i}`,
          provider: 'kora',
          providerReference: `cliqpay-history-collision-${i}`,
          type: 'funding',
          status: 'completed',
          amount: BigInt(2000 + i),
          currency: 'NGN',
          recipientWalletId: walletId,
          metadata: { checkoutUrl: null, grossAmount: null },
        }),
      );
      await ctx.dataSource.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, running_balance, created_at)
         VALUES ($1, $2, 'credit', $3, $3, $4::timestamptz + ($5 || ' microseconds')::interval)`,
        [
          transaction.id,
          walletId,
          transaction.amount.toString(),
          sameMillisecond.toISOString(),
          i,
        ],
      );
    }
    const entries = await ctx.ledgerEntryRepo.find({
      where: { accountId: walletId },
    });
    expect(entries).toHaveLength(rowCount);

    const limit = 2;
    const seenIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const res = await request(ctx.app.getHttpServer())
        .get('/wallet/transactions')
        .query(cursor ? { limit, cursor } : { limit })
        .set('Authorization', `Bearer ${tokenFor(userId)}`)
        .expect(200);
      const body = res.body as HistoryResponse;

      seenIds.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(rowCount);
    } while (cursor);

    expect(new Set(seenIds)).toEqual(new Set(entries.map((e) => e.id)));
  });

  it("shows the recipient as counterparty on the sender's row and the sender as counterparty on the recipient's row, fee-inclusive on the sender's side", async () => {
    const sender = await seedUserWithWallet(ctx, {
      email: 'history-transfer-sender@example.com',
      phone: '+2348022220006',
      username: 'history_transfer_sender',
    });
    const recipient = await seedUserWithWallet(ctx, {
      email: 'history-transfer-recipient@example.com',
      phone: '+2348022220007',
      username: 'history_transfer_recipient',
    });
    await seedCompletedFunding(ctx, {
      walletId: sender.walletId,
      reference: 'cliqpay-history-transfer-fund',
      netAmountMinor: 100_000n,
    });

    await ctx.ledgerService.postTransfer({
      reference: 'cliqpay-history-transfer-1',
      senderWalletId: sender.walletId,
      recipientWalletId: recipient.walletId,
      amount: Money.of(5_000n, 'NGN'),
      platformFee: Money.of(100n, 'NGN'),
    });

    const senderRes = await request(ctx.app.getHttpServer())
      .get('/wallet/transactions')
      .query({ limit: 20 })
      .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
      .expect(200);
    const senderBody = senderRes.body as HistoryResponse;
    const senderTransferRow = senderBody.items.find(
      (i) => i.type === 'p2p_transfer',
    );
    expect(senderTransferRow).toBeDefined();
    expect(senderTransferRow!.direction).toBe('debit');
    // Fee-inclusive: 5000 transfer + 100 platform fee.
    expect(senderTransferRow!.amount.amount).toBe('5100');
    expect(senderTransferRow!.counterparty).toEqual({
      userId: recipient.userId,
      username: 'history_transfer_recipient',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(Object.keys(senderTransferRow!.counterparty!).sort()).toEqual(
      ['firstName', 'lastName', 'userId', 'username'].sort(),
    );

    const recipientRes = await request(ctx.app.getHttpServer())
      .get('/wallet/transactions')
      .query({ limit: 20 })
      .set('Authorization', `Bearer ${tokenFor(recipient.userId)}`)
      .expect(200);
    const recipientBody = recipientRes.body as HistoryResponse;
    const recipientTransferRow = recipientBody.items.find(
      (i) => i.type === 'p2p_transfer',
    );
    expect(recipientTransferRow).toBeDefined();
    expect(recipientTransferRow!.direction).toBe('credit');
    expect(recipientTransferRow!.amount.amount).toBe('5000');
    expect(recipientTransferRow!.counterparty).toEqual({
      userId: sender.userId,
      username: 'history_transfer_sender',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it("never lets one party's history page surface the other party's own leg of a shared transfer", async () => {
    const userA = await seedUserWithWallet(ctx, {
      email: 'history-isolation-a@example.com',
      phone: '+2348022220008',
      username: 'history_isolation_a',
    });
    const userB = await seedUserWithWallet(ctx, {
      email: 'history-isolation-b@example.com',
      phone: '+2348022220009',
      username: 'history_isolation_b',
    });
    await seedCompletedFunding(ctx, {
      walletId: userA.walletId,
      reference: 'cliqpay-history-isolation-fund-a',
      netAmountMinor: 200_000n,
    });
    await seedCompletedFunding(ctx, {
      walletId: userB.walletId,
      reference: 'cliqpay-history-isolation-fund-b',
      netAmountMinor: 50_000n,
    });

    for (let i = 0; i < 4; i++) {
      await ctx.ledgerService.postTransfer({
        reference: `cliqpay-history-isolation-transfer-${i}`,
        senderWalletId: userA.walletId,
        recipientWalletId: userB.walletId,
        amount: Money.of(1_000n, 'NGN'),
        platformFee: Money.zero('NGN'),
      });
    }

    const entriesA = await ctx.ledgerEntryRepo.find({
      where: { accountId: userA.walletId },
    });
    const entriesB = await ctx.ledgerEntryRepo.find({
      where: { accountId: userB.walletId },
    });

    async function pageAllIds(
      userId: string,
      limit: number,
    ): Promise<string[]> {
      const seenIds: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await request(ctx.app.getHttpServer())
          .get('/wallet/transactions')
          .query(cursor ? { limit, cursor } : { limit })
          .set('Authorization', `Bearer ${tokenFor(userId)}`)
          .expect(200);
        const body = res.body as HistoryResponse;
        seenIds.push(...body.items.map((i) => i.id));
        cursor = body.nextCursor ?? undefined;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(
          entriesA.length + entriesB.length + 1,
        );
      } while (cursor);
      return seenIds;
    }

    const seenIdsA = await pageAllIds(userA.userId, 2);
    const seenIdsB = await pageAllIds(userB.userId, 2);

    expect(new Set(seenIdsA)).toEqual(new Set(entriesA.map((e) => e.id)));
    expect(new Set(seenIdsB)).toEqual(new Set(entriesB.map((e) => e.id)));
    expect([...seenIdsA].some((id) => entriesB.some((e) => e.id === id))).toBe(
      false,
    );
    expect([...seenIdsB].some((id) => entriesA.some((e) => e.id === id))).toBe(
      false,
    );
  });
});
