import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
} from './support/payments-test-context';
import {
  balanceOf,
  seedPendingFunding,
  seedUser,
} from './support/funding-completion';
import { assertInvariantHolds } from './support/ledger-invariant';

jest.setTimeout(180_000);

const FIXTURES = join(__dirname, '../fixtures/kora-refunds');
const FAKE_SECRET_KEY = 'fake-kora-secret-key';
const PRINCIPAL = 100_000n;

// A charge.success captured from Kora's sandbox, retargeted at a pending
// funding of this test and signed with the fake adapter's key.
function capturedChargeSuccess(
  fixture: string,
  reference: string,
): { body: Buffer; signature: string; data: { amount: number; fee: number } } {
  const captured = JSON.parse(
    readFileSync(join(FIXTURES, `${fixture}.json`), 'utf8'),
  ) as { rawBody: string };
  const payload = JSON.parse(captured.rawBody) as {
    event: string;
    data: Record<string, unknown> & { amount: number; fee: number };
  };
  payload.data.reference = reference;
  payload.data.payment_reference = reference;
  return {
    body: Buffer.from(JSON.stringify(payload)),
    signature: createHmac('sha256', FAKE_SECRET_KEY)
      .update(JSON.stringify(payload.data))
      .digest('hex'),
    data: payload.data,
  };
}

describe('Funding webhook amounts when the payer or the merchant bears the provider fee', () => {
  let ctx: PaymentsTestContext;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  async function deliverCaptured(fixture: string, requestedMinor: bigint) {
    const { walletId } = await seedUser(ctx, 'tier3');
    const reference = await seedPendingFunding(ctx, walletId, requestedMinor);
    const { body, signature, data } = capturedChargeSuccess(fixture, reference);
    await ctx.paymentsService.handleKoraWebhook(body, signature);
    const funding = await ctx.transactionRepo.findOneByOrFail({ reference });
    return { walletId, reference, funding, data };
  }

  it('credits the requested amount when Kora reports the payer’s gross (the payer bears the fee)', async () => {
    const { walletId, funding, data } = await deliverCaptured(
      'checkout.webhook.charge.success.payer_bears_fee',
      PRINCIPAL,
    );

    expect(data.amount).toBe(1013.97);
    expect(funding.status).toBe('completed');
    expect(await balanceOf(ctx, walletId)).toBe(PRINCIPAL);
    expect(funding.metadata).toMatchObject({
      grossAmount: { amount: '101397', currency: 'NGN' },
    });
    await assertInvariantHolds(ctx.accountRepo);
  });

  it('credits the requested amount when Kora reports it as is (the merchant bears the fee)', async () => {
    const { walletId, funding, data } = await deliverCaptured(
      'checkout.webhook.charge.success.merchant_bears_fee',
      PRINCIPAL,
    );

    expect(data.amount).toBe(1000);
    expect(funding.status).toBe('completed');
    expect(await balanceOf(ctx, walletId)).toBe(PRINCIPAL);
    await assertInvariantHolds(ctx.accountRepo);
  });

  it('fails a funding whose reported amount matches the request under neither reading, crediting nothing', async () => {
    const { walletId, funding } = await deliverCaptured(
      'checkout.webhook.charge.success.payer_bears_fee',
      PRINCIPAL + 50_000n,
    );

    expect(funding.status).toBe('failed');
    expect(await balanceOf(ctx, walletId)).toBe(0n);
  });
});
