import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
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
    expect(transaction.metadata).toEqual({ checkoutUrl: body.checkoutUrl });

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
    expect(transaction.metadata).toEqual({ checkoutUrl: null });
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
});
