import { readFileSync } from 'fs';
import { join } from 'path';
import { createHmac, randomUUID } from 'crypto';
import { AppConfig } from '../../src/config';
import { KoraAdapter } from '../../src/modules/payments/adapters/kora.adapter';
import { Money } from '../../src/shared/primitives/money';

const BASE_URL = 'https://api.korapay.com/merchant/api/v1';
const SECRET_KEY = process.env.KORA_SECRET_KEY;
const FIXTURES = join(__dirname, '../fixtures/kora-refunds');

interface Fixture {
  request: { body: unknown };
  response: { status: number; body: unknown };
}

function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${name}.json`), 'utf8'),
  ) as Fixture;
}

// Every key and every value type must agree; values are not compared because
// references and timestamps differ per run.
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(shapeOf);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, shapeOf(inner)]),
    );
  }
  return value === null ? 'null' : typeof value;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: (await response.json()) as unknown,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Kora's sandbox and live share a host, so this runs only with a test key.
const describeWithSandbox = SECRET_KEY?.startsWith('sk_test_')
  ? describe
  : describe.skip;

describeWithSandbox('Kora refunds (sandbox)', () => {
  const adapter = new KoraAdapter({
    payments: {
      provider: 'kora',
      kora: {
        secretKey: SECRET_KEY,
        webhookUrl: 'https://tunnel.example.invalid/wh',
        redirectUrl: 'https://tunnel.example.invalid/redirect',
      },
    },
  } as AppConfig);

  const paymentReference = `cliqpay-ct-${randomUUID().slice(0, 13)}`;
  const principal = Money.of(100_000n, 'NGN');
  const refundReference = `rfd-contract-${randomUUID()}`.slice(0, 44);

  // A bank-transfer charge settles by itself in the sandbox, so the spec
  // needs no checkout page and no card data.
  beforeAll(async () => {
    const created = await call('POST', '/charges/bank-transfer', {
      reference: paymentReference,
      amount: 1000,
      currency: 'NGN',
      merchant_bears_cost: false,
      customer: { email: 'contract@example.com', name: 'Contract Test' },
    });
    expect(created).toMatchObject({ status: 200 });

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const charge = await call('GET', `/charges/${paymentReference}`);
      if (
        (charge.body as { data?: { status?: string } }).data?.status ===
        'success'
      ) {
        return;
      }
      await sleep(5000);
    }
    throw new Error('sandbox charge did not settle in time');
  }, 180_000);

  it('accepts a refund of the principal and answers in the recorded shape', async () => {
    const result = await adapter.initiateRefund({
      reference: refundReference,
      paymentReference,
      amount: principal,
      reason: 'contract test',
    });

    expect(result).toEqual({ status: 'accepted' });
  });

  it('reports the same refund in the recorded status shape, with the refunded principal', async () => {
    const recorded = fixture('refund.get.partial').response.body;
    let live = await call('GET', `/refunds/${refundReference}`);
    for (
      let i = 0;
      i < 6 &&
      (live.body as { data: { status: string } }).data.status === 'processing';
      i += 1
    ) {
      await sleep(2000);
      live = await call('GET', `/refunds/${refundReference}`);
    }

    expect(live.status).toBe(200);
    expect(shapeOf(live.body)).toEqual(shapeOf(recorded));
    await expect(adapter.verifyRefund(refundReference)).resolves.toEqual({
      status: 'success',
      amount: principal,
    });
  });

  // Kora answers any second attempt on the same payment with a 429 for about
  // a minute, and checks that before it checks the reference.
  it('reports a repeated reference as already_exists', async () => {
    await sleep(65_000);
    await expect(
      adapter.initiateRefund({
        reference: refundReference,
        paymentReference,
        amount: principal,
        reason: 'contract test',
      }),
    ).resolves.toEqual({ status: 'already_exists' });
  }, 120_000);

  it('reports a refund it has never seen as not_found', async () => {
    await expect(
      adapter.verifyRefund(`rfd-contract-missing-${randomUUID()}`.slice(0, 44)),
    ).resolves.toEqual({ status: 'not_found' });
  });

  it('rejects a refund of a payment it does not know, in the recorded error shape', async () => {
    const live = await call('POST', '/refunds/initiate', {
      payment_reference: `cliqpay-contract-missing-${randomUUID()}`,
      reference: `rfd-contract-${randomUUID()}`.slice(0, 44),
      amount: 100,
    });

    expect(live.status).toBe(404);
    expect(shapeOf(live.body)).toEqual(
      shapeOf(fixture('refund.initiate.unknown_payment').response.body),
    );
  });

  it('still verifies a refund webhook with the HMAC-over-data scheme the adapter checks', () => {
    const data = {
      reference: refundReference,
      status: 'success',
      amount: 1000,
    };
    const body = Buffer.from(JSON.stringify({ event: 'refund.success', data }));
    const signature = createHmac('sha256', SECRET_KEY!)
      .update(JSON.stringify(data))
      .digest('hex');

    expect(adapter.verifyWebhookSignature(body, signature)).toBe(true);
  });
});
