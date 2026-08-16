import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { Money } from '../../src/shared/primitives/money';
import { FundWalletResponseDto } from '../../src/modules/payments/dto/fund-wallet-response.dto';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
  seedUserWithWallet,
} from './support/payments-test-context';

jest.setTimeout(120_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

describe('POST /wallet/fund', () => {
  let ctx: PaymentsTestContext;
  let jwtService: JwtService;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  it('creates a pending transaction and returns a checkout URL', async () => {
    const { userId } = await seedUserWithWallet(ctx, {
      email: 'fund-basic@example.com',
      phone: '+2348011110001',
      username: 'fund_basic_user',
    });

    const res = await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ amount: 500000, reference: 'cliqpay-fund-basic-1' })
      .expect(201);

    const body = res.body as FundWalletResponseDto;
    expect(body.checkoutUrl).toBe(
      'https://fake-checkout.cliqpay.test/cliqpay-fund-basic-1',
    );

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-fund-basic-1',
    });
    expect(transaction.type).toBe('funding');
    expect(transaction.status).toBe('pending');
    expect(transaction.provider).toBe('kora');
    expect(transaction.providerReference).toBe('cliqpay-fund-basic-1');
    expect(transaction.amount).toBe(500000n);
    expect(transaction.currency).toBe('NGN');
    expect(transaction.metadata).toEqual({
      checkoutUrl: body.checkoutUrl,
      grossAmount: null,
    });

    expect(ctx.fakeAdapter.initiated).toHaveLength(1);
  });

  it('is idempotent: a repeated reference returns the same checkout URL, no second charge, no second row', async () => {
    const { userId } = await seedUserWithWallet(ctx, {
      email: 'fund-retry@example.com',
      phone: '+2348011110002',
      username: 'fund_retry_user',
    });
    const initiatedBefore = ctx.fakeAdapter.initiated.length;

    const first = await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ amount: 250000, reference: 'cliqpay-fund-retry-1' })
      .expect(201);

    const second = await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ amount: 250000, reference: 'cliqpay-fund-retry-1' })
      .expect(201);

    expect(second.body).toEqual(first.body);
    expect(ctx.fakeAdapter.initiated).toHaveLength(initiatedBefore + 1);

    const transactions = await ctx.transactionRepo.findBy({
      reference: 'cliqpay-fund-retry-1',
    });
    expect(transactions).toHaveLength(1);
  });

  it('rejects a request with no reference', async () => {
    const { userId } = await seedUserWithWallet(ctx, {
      email: 'fund-noref@example.com',
      phone: '+2348011110003',
      username: 'fund_noref_user',
    });

    await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ amount: 250000 })
      .expect(400);
  });

  it('rejects an unauthenticated request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .send({ amount: 250000, reference: 'cliqpay-fund-unauth-1' })
      .expect(401);
  });

  it('marks the transaction failed (not deleted) on a provider failure', async () => {
    const { userId } = await seedUserWithWallet(ctx, {
      email: 'fund-fail@example.com',
      phone: '+2348011110004',
      username: 'fund_fail_user',
    });

    await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ amount: 250000, reference: 'cliqpay-fund-fail-ref' })
      .expect(500);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-fund-fail-ref',
    });
    expect(transaction.status).toBe('failed');
    expect(transaction.metadata).toEqual({
      checkoutUrl: null,
      grossAmount: null,
    });
  });

  it('rejects a request racing an in-flight funding attempt for the same reference, without calling the provider again', async () => {
    const { userId, walletId } = await seedUserWithWallet(ctx, {
      email: 'fund-inflight@example.com',
      phone: '+2348011110005',
      username: 'fund_inflight_user',
    });
    // Simulates the window between the pending row being inserted and the
    // provider call it gated actually returning — exactly what the insert-
    // before-call ordering in PaymentsService.fundWallet exists to protect,
    // reproduced deterministically instead of racing real concurrent
    // requests against Postgres.
    await ctx.transactionRepo.save(
      ctx.transactionRepo.create({
        reference: 'cliqpay-fund-inflight-1',
        provider: 'kora',
        providerReference: 'cliqpay-fund-inflight-1',
        type: 'funding',
        status: 'pending',
        reversesTransactionId: null,
        amount: 250000n,
        currency: 'NGN',
        senderWalletId: null,
        recipientWalletId: walletId,
        metadata: { checkoutUrl: null },
      }),
    );
    const initiatedBefore = ctx.fakeAdapter.initiated.length;

    await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ amount: 250000, reference: 'cliqpay-fund-inflight-1' })
      .expect(409);

    expect(ctx.fakeAdapter.initiated).toHaveLength(initiatedBefore);
  });

  // ADR-0010, defect 1: before the fix the replay lookup was not scoped to
  // the caller, so a reference user A already used, submitted by user B,
  // returned A's checkout URL with a 200. This reproduces exactly that
  // sequence — it would have failed (200 with A's URL) against the old
  // behaviour.
  it('returns 409 with no detail of the other transaction when a different user reuses a reference', async () => {
    const { userId: userA } = await seedUserWithWallet(ctx, {
      email: 'fund-crossuser-a@example.com',
      phone: '+2348011110006',
      username: 'fund_crossuser_a',
    });
    const { userId: userB } = await seedUserWithWallet(ctx, {
      email: 'fund-crossuser-b@example.com',
      phone: '+2348011110007',
      username: 'fund_crossuser_b',
    });
    const initiatedBefore = ctx.fakeAdapter.initiated.length;

    const first = await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userA)}`)
      .send({ amount: 500000, reference: 'cliqpay-fund-crossuser-1' })
      .expect(201);
    const firstBody = first.body as FundWalletResponseDto;

    const second = await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userB)}`)
      .send({ amount: 500000, reference: 'cliqpay-fund-crossuser-1' })
      .expect(409);

    expect(JSON.stringify(second.body)).not.toContain(firstBody.checkoutUrl);
    expect(JSON.stringify(second.body)).not.toContain(
      'cliqpay-fund-crossuser-1',
    );
    expect(ctx.fakeAdapter.initiated).toHaveLength(initiatedBefore + 1);
  });

  // Phase 3 end-of-phase audit: `reference` is a single, globally-unique
  // namespace shared by every transaction type (`transactions.reference` is
  // UNIQUE at the DB level), so a genuinely new row can never be inserted
  // once any transaction — of any type — already holds that reference; the
  // best outcome achievable is a clean, accurate rejection. Before this
  // fix, a P2P transfer's stored row (same reference, same amount) falsely
  // "matched" here — funding's fingerprint carries no counterparty, so the
  // mismatch never surfaced — which fell through toFundWalletResponse's
  // funding-shaped branches (no checkoutUrl, status isn't 'failed') to a
  // *permanently misleading* "already being processed, retry shortly" 409,
  // implying eventual success that could never come. The fix (adding
  // `type` to the fingerprint) turns that false match into an honest
  // `diverged` outcome — 422, "use a new reference" — same as any other
  // reused-reference-with-different-parameters case.
  it('rejects a funding request with an accurate error when its reference was previously used for an unrelated P2P transfer, instead of a misleading "retry shortly"', async () => {
    const { userId: sender, walletId: senderWalletId } =
      await seedUserWithWallet(ctx, {
        email: 'fund-crosstype-sender@example.com',
        phone: '+2348011110020',
        username: 'fund_crosstype_sender',
      });
    const { walletId: recipientWalletId } = await seedUserWithWallet(ctx, {
      email: 'fund-crosstype-recipient@example.com',
      phone: '+2348011110021',
      username: 'fund_crosstype_recipient',
    });
    const topUpReference = 'cliqpay-fund-crosstype-topup';
    await ctx.ledgerService.createPendingFundingTransaction({
      reference: topUpReference,
      provider: 'kora',
      providerReference: topUpReference,
      amount: Money.of(500000n, 'NGN'),
      recipientWalletId: senderWalletId,
      metadata: { checkoutUrl: null, grossAmount: null },
    });
    await ctx.ledgerService.postFunding({
      reference: topUpReference,
      netAmount: Money.of(500000n, 'NGN'),
      providerFee: Money.zero('NGN'),
      providerStatus: 'success',
    });

    await ctx.ledgerService.postTransfer({
      reference: 'cliqpay-fund-crosstype-1',
      senderWalletId,
      recipientWalletId,
      amount: Money.of(500000n, 'NGN'),
      platformFee: Money.zero('NGN'),
    });

    const res = await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(sender)}`)
      .send({ amount: 500000, reference: 'cliqpay-fund-crosstype-1' })
      .expect(422);

    expect(JSON.stringify(res.body)).toMatch(/use a new reference/i);
    expect(JSON.stringify(res.body)).not.toMatch(/retry shortly/i);
  });

  it('returns 422 when the same user reuses a reference with a different amount', async () => {
    const { userId } = await seedUserWithWallet(ctx, {
      email: 'fund-diverged@example.com',
      phone: '+2348011110008',
      username: 'fund_diverged_user',
    });
    const initiatedBefore = ctx.fakeAdapter.initiated.length;

    await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ amount: 250000, reference: 'cliqpay-fund-diverged-1' })
      .expect(201);

    await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ amount: 999999, reference: 'cliqpay-fund-diverged-1' })
      .expect(422);

    expect(ctx.fakeAdapter.initiated).toHaveLength(initiatedBefore + 1);
    const transactions = await ctx.transactionRepo.findBy({
      reference: 'cliqpay-fund-diverged-1',
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amount).toBe(250000n);
  });
});
