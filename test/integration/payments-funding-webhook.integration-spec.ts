import { createHmac } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
  seedUserWithWallet,
} from './support/payments-test-context';
import { assertInvariantHolds } from './support/ledger-invariant';
import { Money } from '../../src/shared/primitives/money';

jest.setTimeout(120_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const FAKE_SECRET_KEY = 'fake-kora-secret-key'; // matches FakeAdapter's fixed secret

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface KoraWebhookData {
  reference: string;
  status: string;
  amount: string;
  fee: number;
}

function signedWebhookBody(data: KoraWebhookData, secret = FAKE_SECRET_KEY) {
  const body = JSON.stringify({ event: 'charge.success', data });
  const signature = createHmac('sha256', secret)
    .update(JSON.stringify(data))
    .digest('hex');
  return { body, signature };
}

describe('POST /wallet/webhook/kora', () => {
  let ctx: PaymentsTestContext;
  let jwtService: JwtService;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  function providerReports(
    reference: string,
    netAmountMinor: bigint,
    feeMinor = 5_000n,
  ): void {
    ctx.fakeAdapter.setVerifyChargeResult(reference, {
      status: 'success',
      netAmount: Money.of(netAmountMinor, 'NGN'),
      providerFee: Money.of(feeMinor, 'NGN'),
    });
  }

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  async function seedPendingFunding(
    email: string,
    phone: string,
    username: string,
    reference: string,
    amountMinorUnits: number,
  ): Promise<{ userId: string; walletId: string }> {
    const seeded = await seedUserWithWallet(ctx, { email, phone, username });
    await request(ctx.app.getHttpServer())
      .post('/wallet/fund')
      .set('Authorization', `Bearer ${tokenFor(seeded.userId)}`)
      .send({ amount: amountMinorUnits, reference })
      .expect(201);
    return seeded;
  }

  it('completes a pending funding transaction and posts the four §4.2 ledger entries', async () => {
    const { walletId } = await seedPendingFunding(
      'webhook-happy@example.com',
      '+2348022220001',
      'webhook_happy_user',
      'cliqpay-webhook-happy-1',
      500_000,
    );
    const walletBefore = await ctx.accountRepo.findOneByOrFail({
      id: walletId,
    });
    const float = await ctx.accountRepo.findOneByOrFail({
      role: 'float',
      provider: 'kora',
      currency: 'NGN',
    });
    const feeExpense = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_expense',
      provider: 'kora',
      currency: 'NGN',
    });
    const feeRecovery = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_recovery',
      provider: 'kora',
      currency: 'NGN',
    });
    const floatBefore = float.balance;
    const feeExpenseBefore = feeExpense.balance;
    const feeRecoveryBefore = feeRecovery.balance;

    providerReports('cliqpay-webhook-happy-1', 500_000n);
    const { body, signature } = signedWebhookBody({
      reference: 'cliqpay-webhook-happy-1',
      status: 'success',
      amount: '5000.00',
      fee: 50,
    });

    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(body)
      .expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-webhook-happy-1',
    });
    expect(transaction.status).toBe('completed');
    // grossAmount (net + provider fee, §4.2) is merged into metadata at
    // completion via a real jsonb `||`, not an overwrite — checkoutUrl
    // (set at initiation) must still be there alongside it.
    expect(transaction.metadata).toEqual({
      checkoutUrl: expect.stringContaining(
        'https://fake-checkout.cliqpay.test/',
      ) as unknown,
      grossAmount: { amount: '505000', currency: 'NGN' },
    });

    const walletAfter = await ctx.accountRepo.findOneByOrFail({
      id: walletId,
    });
    const floatAfter = await ctx.accountRepo.findOneByOrFail({
      id: float.id,
    });
    const feeExpenseAfter = await ctx.accountRepo.findOneByOrFail({
      id: feeExpense.id,
    });
    const feeRecoveryAfter = await ctx.accountRepo.findOneByOrFail({
      id: feeRecovery.id,
    });
    expect(walletAfter.balance).toBe(walletBefore.balance + 500_000n);
    expect(floatAfter.balance).toBe(floatBefore + 500_000n);
    expect(feeExpenseAfter.balance).toBe(feeExpenseBefore + 5_000n);
    expect(feeRecoveryAfter.balance).toBe(feeRecoveryBefore + 5_000n);

    const entries = await ctx.ledgerEntryRepo.findBy({
      transactionId: transaction.id,
    });
    expect(entries).toHaveLength(4);
    expect(entries.find((e) => e.accountId === float.id)).toMatchObject({
      direction: 'debit',
      amount: 500_000n,
      runningBalance: floatAfter.balance,
    });
    expect(entries.find((e) => e.accountId === walletId)).toMatchObject({
      direction: 'credit',
      amount: 500_000n,
      runningBalance: walletAfter.balance,
    });
    expect(entries.find((e) => e.accountId === feeExpense.id)).toMatchObject({
      direction: 'debit',
      amount: 5_000n,
      runningBalance: feeExpenseAfter.balance,
    });
    expect(entries.find((e) => e.accountId === feeRecovery.id)).toMatchObject({
      direction: 'credit',
      amount: 5_000n,
      runningBalance: feeRecoveryAfter.balance,
    });

    await assertInvariantHolds(ctx.accountRepo);

    await waitFor(() =>
      ctx.emailAdapter.sent.some((m) => m.to === 'webhook-happy@example.com'),
    );
    const email = ctx.emailAdapter.sent.find(
      (m) => m.to === 'webhook-happy@example.com',
    )!;
    expect(email.subject).toBe('Your Cliqpay wallet has been funded');
  });

  it('rejects an invalid signature with 401, without writing to the ledger or changing status', async () => {
    await seedPendingFunding(
      'webhook-invalid-sig@example.com',
      '+2348022220002',
      'webhook_badsig_user',
      'cliqpay-webhook-badsig-1',
      250_000,
    );

    const { body } = signedWebhookBody({
      reference: 'cliqpay-webhook-badsig-1',
      status: 'success',
      amount: '2500.00',
      fee: 25,
    });

    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', 'deadbeef'.repeat(8))
      .send(body)
      .expect(401);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-webhook-badsig-1',
    });
    expect(transaction.status).toBe('pending');

    const entries = await ctx.ledgerEntryRepo.findBy({
      transactionId: transaction.id,
    });
    expect(entries).toHaveLength(0);
  });

  it('posts ledger entries exactly once when the same webhook is delivered twice', async () => {
    await seedPendingFunding(
      'webhook-dup@example.com',
      '+2348022220003',
      'webhook_dup_user',
      'cliqpay-webhook-dup-1',
      100_000,
    );

    providerReports('cliqpay-webhook-dup-1', 100_000n, 1_000n);
    const { body, signature } = signedWebhookBody({
      reference: 'cliqpay-webhook-dup-1',
      status: 'success',
      amount: '1000.00',
      fee: 10,
    });

    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(body)
      .expect(200);

    // Duplicate delivery — same signature, same body, no error, no-op.
    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(body)
      .expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-webhook-dup-1',
    });
    expect(transaction.status).toBe('completed');

    const entries = await ctx.ledgerEntryRepo.findBy({
      transactionId: transaction.id,
    });
    expect(entries).toHaveLength(4);

    await assertInvariantHolds(ctx.accountRepo);
  });

  it('acts on the same "data" it verified the signature against, not a duplicate top-level "data" key', async () => {
    // Regression: extractTopLevelJsonField (used for signature verification)
    // resolves the *first* top-level "data" key; native JSON.parse resolves
    // the *last*. A body carrying two "data" keys used to let the signature
    // verify against one while the handler acted on the other — a captured
    // valid (data, signature) pair plus an appended second "data" key was
    // enough to redirect what got posted. Verified and acted-on data now
    // both come from the same extraction, so this must be a no-op: the
    // legit reference resolves normally, the injected one is never touched.
    const { walletId } = await seedPendingFunding(
      'webhook-dualdata@example.com',
      '+2348022220099',
      'webhook_dualdata_user',
      'cliqpay-webhook-dualdata-legit',
      100_000,
    );

    const legitData = {
      reference: 'cliqpay-webhook-dualdata-legit',
      status: 'success',
      amount: '1000.00',
      fee: 10,
    };
    const injectedData = {
      reference: 'cliqpay-webhook-dualdata-nonexistent',
      status: 'success',
      amount: '999999.00',
      fee: 0,
    };
    providerReports('cliqpay-webhook-dualdata-legit', 100_000n, 1_000n);
    const legitDataJson = JSON.stringify(legitData);
    const body = `{"event":"charge.success","data":${legitDataJson},"data":${JSON.stringify(injectedData)}}`;
    const signature = createHmac('sha256', FAKE_SECRET_KEY)
      .update(legitDataJson)
      .digest('hex');

    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(body)
      .expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-webhook-dualdata-legit',
    });
    expect(transaction.status).toBe('completed');

    const injected = await ctx.transactionRepo.findOneBy({
      reference: 'cliqpay-webhook-dualdata-nonexistent',
    });
    expect(injected).toBeNull();

    const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
    expect(wallet.balance).toBe(100_000n);

    await assertInvariantHolds(ctx.accountRepo);
  });

  it('leaves a transaction pending on a non-terminal status instead of permanently failing it', async () => {
    // Regression: collapsing anything-not-"success" into "failed" would
    // permanently kill a transaction Kora later reports as successful,
    // since the poll job only revisits `status = 'pending'` rows. Kora's
    // real charge-verify status set includes "processing" for a charge
    // still in flight (see KoraAdapter.verifyCharge) — the webhook must
    // treat that the same way: leave it alone.
    const { walletId } = await seedPendingFunding(
      'webhook-nonterminal@example.com',
      '+2348022220098',
      'webhook_nonterminal_user',
      'cliqpay-webhook-nonterminal-1',
      300_000,
    );

    const { body, signature } = signedWebhookBody({
      reference: 'cliqpay-webhook-nonterminal-1',
      status: 'processing',
      amount: '3000.00',
      fee: 30,
    });

    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(body)
      .expect(200);

    const afterProcessing = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-webhook-nonterminal-1',
    });
    expect(afterProcessing.status).toBe('pending');
    const entriesAfterProcessing = await ctx.ledgerEntryRepo.findBy({
      transactionId: afterProcessing.id,
    });
    expect(entriesAfterProcessing).toHaveLength(0);

    // A later delivery completes it once the provider reports success.
    providerReports('cliqpay-webhook-nonterminal-1', 300_000n, 3_000n);
    const success = signedWebhookBody({
      reference: 'cliqpay-webhook-nonterminal-1',
      status: 'success',
      amount: '3000.00',
      fee: 30,
    });
    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', success.signature)
      .send(success.body)
      .expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-webhook-nonterminal-1',
    });
    expect(transaction.status).toBe('completed');
    const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
    expect(wallet.balance).toBe(300_000n);

    await assertInvariantHolds(ctx.accountRepo);
  });

  it('rejects a payload without a reference with 400, not an uncaught 500', async () => {
    const data = { status: 'success', amount: '5000.00', fee: 50 };
    const malformed = JSON.stringify({ event: 'charge.success', data });
    const signature = createHmac('sha256', FAKE_SECRET_KEY)
      .update(JSON.stringify(data))
      .digest('hex');

    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(malformed)
      .expect(400);
  });

  it('posts nothing when a validly signed success webhook is contradicted by the provider reporting the charge failed', async () => {
    const { walletId } = await seedPendingFunding(
      'webhook-forged@example.com',
      '+2348022220004',
      'webhook_forged_user',
      'cliqpay-webhook-forged-1',
      500_000,
    );
    ctx.fakeAdapter.setVerifyChargeResult('cliqpay-webhook-forged-1', {
      status: 'failed',
    });

    const { body, signature } = signedWebhookBody({
      reference: 'cliqpay-webhook-forged-1',
      status: 'success',
      amount: '5000.00',
      fee: 50,
    });
    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(body)
      .expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-webhook-forged-1',
    });
    expect(transaction.status).toBe('failed');
    expect(
      await ctx.ledgerEntryRepo.findBy({ transactionId: transaction.id }),
    ).toHaveLength(0);
    const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
    expect(wallet.balance).toBe(0n);
    await assertInvariantHolds(ctx.accountRepo);
  });

  it('posts nothing when a validly signed success webhook arrives while the provider reports the charge still pending', async () => {
    await seedPendingFunding(
      'webhook-unconfirmed@example.com',
      '+2348022220005',
      'webhook_unconfirmed_user',
      'cliqpay-webhook-unconfirmed-1',
      500_000,
    );

    const { body, signature } = signedWebhookBody({
      reference: 'cliqpay-webhook-unconfirmed-1',
      status: 'success',
      amount: '5000.00',
      fee: 50,
    });
    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(body)
      .expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-webhook-unconfirmed-1',
    });
    expect(transaction.status).toBe('pending');
    expect(
      await ctx.ledgerEntryRepo.findBy({ transactionId: transaction.id }),
    ).toHaveLength(0);
  });

  it('leaves the transaction pending and returns 200 when the provider cannot be reached', async () => {
    await seedPendingFunding(
      'webhook-timeout@example.com',
      '+2348022220006',
      'webhook_timeout_user',
      'cliqpay-webhook-timeout-1',
      500_000,
    );
    ctx.fakeAdapter.setVerifyError(
      'cliqpay-webhook-timeout-1',
      new Error('request timed out'),
    );

    const { body, signature } = signedWebhookBody({
      reference: 'cliqpay-webhook-timeout-1',
      status: 'success',
      amount: '5000.00',
      fee: 50,
    });
    await request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(body)
      .expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-webhook-timeout-1',
    });
    expect(transaction.status).toBe('pending');
    expect(
      await ctx.ledgerEntryRepo.findBy({ transactionId: transaction.id }),
    ).toHaveLength(0);
  });
});
