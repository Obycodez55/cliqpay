import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { TransactionHistoryItemDto } from '../../src/modules/ledger/dto/transaction-history-item.dto';
import { PaginatedResult } from '../../src/common/interfaces/paginated-result.interface';
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
});
