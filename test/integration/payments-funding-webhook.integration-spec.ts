import { createHmac } from 'crypto';
import * as request from 'supertest';
import { IsNull } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
  seedUserWithWallet,
} from './support/payments-test-context';

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

// The invariant §4.3 requires: across all providers, float_<ccy> ==
// Σ(user wallet balances) + fee_income_<ccy>. Only one provider (kora) and
// one currency (NGN) are active, so this collapses to a single float row.
async function assertInvariantHolds(ctx: PaymentsTestContext): Promise<void> {
  const float = await ctx.accountRepo.findOneByOrFail({
    role: 'float',
    provider: 'kora',
    currency: 'NGN',
  });
  const feeIncome = await ctx.accountRepo.findOneByOrFail({
    role: 'fee_income',
    provider: IsNull(),
    currency: 'NGN',
  });
  const wallets = await ctx.accountRepo.findBy({
    role: 'user_wallet',
    currency: 'NGN',
  });
  const walletSum = wallets.reduce((sum, w) => sum + w.balance, 0n);

  expect(float.balance).toBe(walletSum + feeIncome.balance);
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

    await assertInvariantHolds(ctx);

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

    await assertInvariantHolds(ctx);
  });
});
