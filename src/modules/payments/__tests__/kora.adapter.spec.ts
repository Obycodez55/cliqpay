import { createHmac } from 'crypto';
import { KoraAdapter } from '../adapters/kora.adapter';
import { AppConfig } from '../../../config';
import { Money } from '../../../shared/primitives/money';

function buildConfig(): AppConfig {
  return {
    payments: { provider: 'kora', kora: { secretKey: 'sk_test_secret' } },
  } as AppConfig;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe('KoraAdapter', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  describe('initiatePayment', () => {
    it('maps a successful charges/initialize response to a checkout URL', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'Charge created successfully',
          data: {
            reference: 'cliqpay-ref-1',
            checkout_url: 'https://test-checkout.korapay.com/KPY-PI-1/pay',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      const result = await adapter.initiatePayment({
        reference: 'cliqpay-ref-1',
        amount: Money.of(500000n, 'NGN'),
        customerEmail: 'jane@example.com',
      });

      expect(result).toEqual({
        checkoutUrl: 'https://test-checkout.korapay.com/KPY-PI-1/pay',
      });
    });

    it('sends amount as a major-unit decimal string, not minor units', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'ok',
          data: { reference: 'r', checkout_url: 'https://example.com/pay' },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await adapter.initiatePayment({
        reference: 'cliqpay-ref-2',
        amount: Money.of(500000n, 'NGN'),
        customerEmail: 'jane@example.com',
      });

      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(requestInit.body as string) as {
        amount: string;
        currency: string;
        reference: string;
        customer: { email: string };
      };
      expect(sentBody).toEqual({
        amount: '5000.00',
        currency: 'NGN',
        reference: 'cliqpay-ref-2',
        customer: { email: 'jane@example.com' },
      });
    });

    it('throws on a non-ok response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, { status: false, message: 'invalid reference' }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(
        adapter.initiatePayment({
          reference: 'cliqpay-ref-3',
          amount: Money.of(1000n, 'NGN'),
          customerEmail: 'jane@example.com',
        }),
      ).rejects.toThrow(/invalid reference/);
    });

    it('throws a descriptive error on a network failure', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const adapter = new KoraAdapter(buildConfig());

      await expect(
        adapter.initiatePayment({
          reference: 'cliqpay-ref-4',
          amount: Money.of(1000n, 'NGN'),
          customerEmail: 'jane@example.com',
        }),
      ).rejects.toThrow(/ECONNRESET/);
    });
  });

  describe('verifyWebhookSignature', () => {
    it('accepts a signature computed the same way Kora computes it', () => {
      const adapter = new KoraAdapter(buildConfig());
      const data = { reference: 'cliqpay-ref-1', status: 'success' };
      const signature = createHmac('sha256', 'sk_test_secret')
        .update(JSON.stringify(data))
        .digest('hex');

      expect(adapter.verifyWebhookSignature(data, signature)).toBe(true);
    });

    it('rejects a signature computed with the wrong secret', () => {
      const adapter = new KoraAdapter(buildConfig());
      const data = { reference: 'cliqpay-ref-1', status: 'success' };
      const signature = createHmac('sha256', 'wrong-secret')
        .update(JSON.stringify(data))
        .digest('hex');

      expect(adapter.verifyWebhookSignature(data, signature)).toBe(false);
    });

    it('rejects a signature for different data', () => {
      const adapter = new KoraAdapter(buildConfig());
      const signature = createHmac('sha256', 'sk_test_secret')
        .update(JSON.stringify({ reference: 'cliqpay-ref-1' }))
        .digest('hex');

      expect(
        adapter.verifyWebhookSignature(
          { reference: 'cliqpay-ref-2' },
          signature,
        ),
      ).toBe(false);
    });
  });
});
