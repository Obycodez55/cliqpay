import { randomUUID } from 'crypto';
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

describe('GET /wallet/transactions with held and refunded fundings', () => {
  let ctx: LedgerTestContext;
  let jwtService: JwtService;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createLedgerTestContext();
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyLedgerTestContext(ctx);
  });

  const tokenFor = (userId: string) =>
    jwtService.sign({ sub: userId, sid: 'test-session' });

  const history = async (userId: string, query: Record<string, unknown> = {}) =>
    (
      await request(ctx.app.getHttpServer())
        .get('/wallet/transactions')
        .query({ limit: 20, ...query })
        .set('Authorization', `Bearer ${tokenFor(userId)}`)
        .expect(200)
    ).body as HistoryResponse;

  async function seedUser() {
    seq += 1;
    return seedUserWithWallet(ctx, {
      email: `held-history-${seq}@example.com`,
      phone: `+2348${String(50_000_000 + seq).padStart(8, '0')}`,
      username: `held_history_user_${seq}`,
    });
  }

  async function heldFunding(
    walletId: string,
    netMinor: bigint,
    settle: boolean,
  ): Promise<{ reference: string; id: string }> {
    const reference = `cliqpay-held-history-${randomUUID()}`;
    const net = Money.of(netMinor, 'NGN');
    await ctx.ledgerService.createPendingFundingTransaction({
      reference,
      provider: 'kora',
      providerReference: reference,
      amount: net,
      recipientWalletId: walletId,
      metadata: { checkoutUrl: null, grossAmount: null },
    });
    const held = await ctx.dataSource.transaction((manager) =>
      ctx.ledgerService.holdFundingWithinTransaction(manager, {
        reference,
        netAmount: net,
        providerFee: Money.zero('NGN'),
        providerStatus: 'success',
      }),
    );
    if (settle) {
      await ctx.ledgerService.settleRefund({
        refundReference: held!.refundReference,
        providerReportedAmount: net,
      });
    }
    return { reference, id: held!.fundingTransactionId };
  }

  async function seedMixedHistory() {
    const { userId, walletId } = await seedUser();
    await seedCompletedFunding(ctx, {
      walletId,
      reference: `cliqpay-held-history-f1-${userId}`,
      netAmountMinor: 100_000n,
    });
    const held = await heldFunding(walletId, 200_000n, false);
    const refunded = await heldFunding(walletId, 300_000n, true);
    await seedCompletedFunding(ctx, {
      walletId,
      reference: `cliqpay-held-history-f2-${userId}`,
      netAmountMinor: 400_000n,
    });
    return { userId, walletId, held, refunded };
  }

  it('shows held and refunded fundings with their status and amount, among normal ones, newest first', async () => {
    const { userId, held, refunded } = await seedMixedHistory();

    const body = await history(userId);

    expect(body.items.map((i) => [i.status, i.amount.amount])).toEqual([
      ['completed', '400000'],
      ['refunded', '300000'],
      ['held', '200000'],
      ['completed', '100000'],
    ]);
    expect(body.items[1]).toMatchObject({
      id: refunded.id,
      reference: refunded.reference,
      type: 'funding',
      direction: null,
      counterparty: null,
    });
    expect(body.items[2]).toMatchObject({
      id: held.id,
      reference: held.reference,
      type: 'funding',
      direction: null,
    });
    for (const item of [body.items[0], body.items[3]]) {
      expect(item.direction).toBe('credit');
      expect(item.type).toBe('funding');
    }
  });

  it('does not touch the balance: only completed fundings are in it', async () => {
    const { userId } = await seedMixedHistory();

    const res = await request(ctx.app.getHttpServer())
      .get('/wallet/balance')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .expect(200);

    expect((res.body as { balance: { amount: string } }).balance.amount).toBe(
      '500000',
    );
  });

  it('pages through held, refunded and normal items one at a time with no duplicates or gaps', async () => {
    const { userId } = await seedMixedHistory();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const body = await history(userId, { limit: 1, cursor });
      seen.push(...body.items.map((i) => i.id));
      if (!body.nextCursor) {
        break;
      }
      cursor = body.nextCursor;
    }

    const full = (await history(userId)).items.map((i) => i.id);
    expect(seen).toEqual(full);
    expect(new Set(seen).size).toBe(4);
  });

  it('never shows another user’s held funding', async () => {
    const { userId } = await seedMixedHistory();
    const other = await seedUser();
    await heldFunding(other.walletId, 999_000n, false);

    const body = await history(userId);

    expect(body.items.map((i) => i.amount.amount)).not.toContain('999000');
  });

  it('shows a held funding alone for a wallet that has no ledger entries', async () => {
    const { userId, walletId } = await seedUser();
    await heldFunding(walletId, 250_000n, false);

    const body = await history(userId);

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ status: 'held', direction: null });
    expect(body.nextCursor).toBeNull();
  });
});
