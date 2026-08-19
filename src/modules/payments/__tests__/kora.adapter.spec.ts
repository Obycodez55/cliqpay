import { createHmac } from 'crypto';
import { KoraAdapter } from '../adapters/kora.adapter';
import { AppConfig } from '../../../config';
import { Money } from '../../../shared/primitives/money';

function buildConfig(): AppConfig {
  return {
    payments: {
      provider: 'kora',
      kora: {
        secretKey: 'sk_test_secret',
        webhookUrl: 'https://api.cliqpay.test/wallet/webhook/kora',
        redirectUrl: 'https://app.cliqpay.test/wallet/funding-complete',
      },
    },
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
        notification_url: string;
        redirect_url: string;
      };
      expect(sentBody).toEqual({
        amount: '5000.00',
        currency: 'NGN',
        reference: 'cliqpay-ref-2',
        customer: { email: 'jane@example.com' },
        // Sent explicitly rather than relying on Kora dashboard config —
        // Phase 2 audit, M2.
        notification_url: 'https://api.cliqpay.test/wallet/webhook/kora',
        redirect_url: 'https://app.cliqpay.test/wallet/funding-complete',
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
    function rawBody(data: unknown): Buffer {
      return Buffer.from(
        JSON.stringify({ event: 'charge.success', data }),
        'utf8',
      );
    }

    it('accepts a signature computed the same way Kora computes it', () => {
      const adapter = new KoraAdapter(buildConfig());
      const data = { reference: 'cliqpay-ref-1', status: 'success' };
      const signature = createHmac('sha256', 'sk_test_secret')
        .update(JSON.stringify(data))
        .digest('hex');

      expect(adapter.verifyWebhookSignature(rawBody(data), signature)).toBe(
        true,
      );
    });

    it('rejects a signature computed with the wrong secret', () => {
      const adapter = new KoraAdapter(buildConfig());
      const data = { reference: 'cliqpay-ref-1', status: 'success' };
      const signature = createHmac('sha256', 'wrong-secret')
        .update(JSON.stringify(data))
        .digest('hex');

      expect(adapter.verifyWebhookSignature(rawBody(data), signature)).toBe(
        false,
      );
    });

    it('rejects a signature for different data', () => {
      const adapter = new KoraAdapter(buildConfig());
      const signature = createHmac('sha256', 'sk_test_secret')
        .update(JSON.stringify({ reference: 'cliqpay-ref-1' }))
        .digest('hex');

      expect(
        adapter.verifyWebhookSignature(
          rawBody({ reference: 'cliqpay-ref-2' }),
          signature,
        ),
      ).toBe(false);
    });

    it('rejects a malformed body with no top-level data field', () => {
      const adapter = new KoraAdapter(buildConfig());
      const signature = createHmac('sha256', 'sk_test_secret')
        .update(JSON.stringify({ reference: 'cliqpay-ref-1' }))
        .digest('hex');

      expect(
        adapter.verifyWebhookSignature(
          Buffer.from(JSON.stringify({ event: 'charge.success' }), 'utf8'),
          signature,
        ),
      ).toBe(false);
    });

    it('is unaffected by pretty-printing the surrounding envelope', () => {
      const adapter = new KoraAdapter(buildConfig());
      const data = { reference: 'cliqpay-ref-1', status: 'success' };
      const signature = createHmac('sha256', 'sk_test_secret')
        .update(JSON.stringify(data))
        .digest('hex');

      const prettyBody = Buffer.from(
        `{\n  "event": "charge.success",\n  "data": ${JSON.stringify(data)}\n}`,
        'utf8',
      );

      expect(adapter.verifyWebhookSignature(prettyBody, signature)).toBe(true);
    });
  });

  describe('verifyCharge', () => {
    it('maps a "success" verify response to netAmount/providerFee', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'ok',
          data: {
            reference: 'cliqpay-ref-1',
            status: 'success',
            amount: '5000.00',
            fee: 50,
            currency: 'NGN',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      const result = await adapter.verifyCharge('cliqpay-ref-1');

      expect(result).toEqual({
        status: 'success',
        netAmount: Money.of(500000n, 'NGN'),
        providerFee: Money.of(5000n, 'NGN'),
      });
    });

    it('maps a "failed" verify response to a failed outcome', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'ok',
          data: {
            reference: 'cliqpay-ref-1',
            status: 'failed',
            amount: '5000.00',
            fee: 0,
            currency: 'NGN',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyCharge('cliqpay-ref-1')).resolves.toEqual({
        status: 'failed',
      });
    });

    it('maps Kora\'s "processing" status to a pending outcome', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'ok',
          data: {
            reference: 'cliqpay-ref-1',
            status: 'processing',
            amount: '5000.00',
            fee: 0,
            currency: 'NGN',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyCharge('cliqpay-ref-1')).resolves.toEqual({
        status: 'pending',
      });
    });

    it('throws on a non-ok response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, { status: false, message: 'not found' }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyCharge('cliqpay-ref-1')).rejects.toThrow(
        /not found/,
      );
    });

    it('throws a descriptive error on a network failure', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyCharge('cliqpay-ref-1')).rejects.toThrow(
        /ECONNRESET/,
      );
    });
  });

  describe('getBalance', () => {
    it('sums available_balance and pending_balance for the requested currency', async () => {
      // float_ngn is credited the moment a charge succeeds, not once Kora
      // settles it — pending_balance is still money Kora owes us, so it
      // has to count too (see the method's own comment for why an earlier
      // available-only version was wrong).
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'success',
          data: {
            NGN: { pending_balance: 10_000, available_balance: 5_001_000 },
            USD: { pending_balance: 0, available_balance: 200 },
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      const result = await adapter.getBalance('NGN');

      expect(result).toEqual(Money.fromDecimalString('5011000', 'NGN'));
    });

    it('throws when the response has no data for the requested currency', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'success',
          data: { USD: { pending_balance: 0, available_balance: 200 } },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.getBalance('NGN')).rejects.toThrow(/NGN/);
    });

    it('throws on a non-ok response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(401, { status: false, message: 'unauthorized' }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.getBalance('NGN')).rejects.toThrow(/unauthorized/);
    });

    it('throws a descriptive error on a network failure', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.getBalance('NGN')).rejects.toThrow(/ECONNRESET/);
    });
  });

  // Shapes below are ground truth from a real sandbox call to
  // POST /misc/banks/resolve, run during issue #27's design — see
  // KoraAdapter.resolveBankAccount and docs/adr/0007's discipline.
  describe('resolveBankAccount', () => {
    it('maps a resolved account to bankName/accountName', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'Request completed',
          data: {
            bank_name: 'United Bank for Africa',
            bank_code: '033',
            account_number: '0000000000',
            account_name: 'Test Bank Account - Success',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      const result = await adapter.resolveBankAccount('033', '0000000000');

      expect(result).toEqual({
        status: 'resolved',
        bankName: 'United Bank for Africa',
        accountName: 'Test Bank Account - Success',
      });
    });

    it('sends the bank code and account number as bank/account', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'ok',
          data: {
            bank_name: 'GTBank',
            bank_code: '058',
            account_number: '0123456789',
            account_name: 'Jane Doe',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await adapter.resolveBankAccount('058', '0123456789');

      const [url, requestInit] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toBe(
        'https://api.korapay.com/merchant/api/v1/misc/banks/resolve',
      );
      expect(JSON.parse(requestInit.body as string)).toEqual({
        bank: '058',
        account: '0123456789',
      });
    });

    it('maps a 400 "account not found" response to a not_found result', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, {
          status: false,
          error: 'bad_request',
          message:
            "We couldn't find this bank account. Please check the details and try again.",
          data: { code: 'AA027' },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(
        adapter.resolveBankAccount('033', '1111111111'),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('maps a 404 "invalid bank" response to a not_found result', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, {
          status: false,
          code: 'AA026',
          message: 'Invalid bank provided.',
          data: null,
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(
        adapter.resolveBankAccount('999', '0000000000'),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('throws on a non-ok, non-400/404 response (system failure)', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(401, { status: false, message: 'unauthorized' }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(
        adapter.resolveBankAccount('033', '0000000000'),
      ).rejects.toThrow(/unauthorized/);
    });

    it('throws a descriptive error on a network failure', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const adapter = new KoraAdapter(buildConfig());

      await expect(
        adapter.resolveBankAccount('033', '0000000000'),
      ).rejects.toThrow(/ECONNRESET/);
    });
  });

  // Shapes below are ground truth from a real sandbox call to
  // POST /transactions/disburse, run during issue #28's design — see
  // KoraAdapter.initiatePayout.
  describe('initiatePayout', () => {
    it('maps a "processing" disburse response to an accepted outcome', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'Transfer initiated successfully.',
          data: {
            amount: '1000.00',
            fee: '30.00',
            currency: 'NGN',
            status: 'processing',
            reference: 'cliqpay-payout-1',
            message: 'Payout processing',
            customer: { name: 'Test User', email: 'jane@example.com' },
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      const result = await adapter.initiatePayout({
        reference: 'cliqpay-payout-1',
        amount: Money.of(100000n, 'NGN'),
        bankCode: '033',
        accountNumber: '0000000000',
        accountName: 'Jane Doe',
        customerEmail: 'jane@example.com',
      });

      expect(result).toEqual({ status: 'accepted' });
    });

    it('sends the destination shape disburse expects, amount as a major-unit decimal string', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'ok',
          data: { status: 'processing', message: 'ok', reference: 'r' },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await adapter.initiatePayout({
        reference: 'cliqpay-payout-2',
        amount: Money.of(100000n, 'NGN'),
        bankCode: '033',
        accountNumber: '0000000000',
        accountName: 'Jane Doe',
        customerEmail: 'jane@example.com',
      });

      const [url, requestInit] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toBe(
        'https://api.korapay.com/merchant/api/v1/transactions/disburse',
      );
      expect(JSON.parse(requestInit.body as string)).toEqual({
        reference: 'cliqpay-payout-2',
        destination: {
          type: 'bank_account',
          amount: '1000.00',
          currency: 'NGN',
          narration: 'Cliqpay withdrawal cliqpay-payout-2',
          bank_account: { bank: '033', account: '0000000000' },
          customer: { name: 'Jane Doe', email: 'jane@example.com' },
        },
      });
    });

    it('maps a 409 synchronous rejection to a typed rejected outcome, not a thrown error', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, {
          status: false,
          error: 'conflict',
          message: 'Invalid bank provided.',
          data: {
            status: 'failed',
            message: 'Invalid bank provided.',
            reference: 'cliqpay-payout-3',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      const result = await adapter.initiatePayout({
        reference: 'cliqpay-payout-3',
        amount: Money.of(100000n, 'NGN'),
        bankCode: '999',
        accountNumber: '0000000000',
        accountName: 'Jane Doe',
        customerEmail: 'jane@example.com',
      });

      expect(result).toEqual({
        status: 'rejected',
        reason: 'Invalid bank provided.',
      });
    });

    // A non-ok, non-409 response isn't a confirmed rejection — Kora's
    // receipt of the payout is genuinely unknown, and debit-first already
    // moved money out of the wallet, so this must not be a thrown error a
    // caller could mistake for "safe to reverse" (see InitiatePayoutResult's
    // `unknown` case).
    it('maps a non-ok, non-409 response to a typed unknown outcome, not a thrown error', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(401, { status: false, message: 'unauthorized' }),
      );
      const adapter = new KoraAdapter(buildConfig());

      const result = await adapter.initiatePayout({
        reference: 'cliqpay-payout-4',
        amount: Money.of(100000n, 'NGN'),
        bankCode: '033',
        accountNumber: '0000000000',
        accountName: 'Jane Doe',
        customerEmail: 'jane@example.com',
      });

      expect(result.status).toBe('unknown');
      expect((result as { detail: string }).detail).toMatch(/unauthorized/);
    });

    it('maps a network failure to a typed unknown outcome, not a thrown error', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const adapter = new KoraAdapter(buildConfig());

      const result = await adapter.initiatePayout({
        reference: 'cliqpay-payout-5',
        amount: Money.of(100000n, 'NGN'),
        bankCode: '033',
        accountNumber: '0000000000',
        accountName: 'Jane Doe',
        customerEmail: 'jane@example.com',
      });

      expect(result.status).toBe('unknown');
      expect((result as { detail: string }).detail).toMatch(/ECONNRESET/);
    });
  });
});
