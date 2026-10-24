import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
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

const REFUND_FIXTURES = join(
  __dirname,
  '../../../../test/fixtures/kora-refunds',
);

interface RefundFixture {
  request: {
    method: string;
    path: string;
    body: Record<string, unknown> | null;
  };
  response: { status: number; body: unknown };
}

function refundFixture(name: string): RefundFixture {
  return JSON.parse(
    readFileSync(join(REFUND_FIXTURES, `${name}.json`), 'utf8'),
  ) as RefundFixture;
}

function respondWith(name: string) {
  const { response } = refundFixture(name);
  return jsonResponse(response.status, response.body);
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

    // A body that can't be read is just as unconfirmed as a network error:
    // debit-first already moved the money, so none of these may throw or
    // be mistaken for a rejection.
    describe.each([
      [
        'a non-JSON 502',
        () => ({
          ok: false,
          status: 502,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        }),
      ],
      [
        'a non-JSON 200',
        () => ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        }),
      ],
      ['a JSON null body', () => jsonResponse(200, null)],
      [
        'a connection reset while reading the body',
        () => ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new TypeError('terminated')),
        }),
      ],
    ])('when the response is %s', (_label, buildResponse) => {
      it('maps to a typed unknown outcome, not a thrown error', async () => {
        fetchMock.mockResolvedValue(buildResponse());
        const adapter = new KoraAdapter(buildConfig());

        const result = await adapter.initiatePayout({
          reference: 'cliqpay-payout-6',
          amount: Money.of(100000n, 'NGN'),
          bankCode: '033',
          accountNumber: '0000000000',
          accountName: 'Jane Doe',
          customerEmail: 'jane@example.com',
        });

        expect(result.status).toBe('unknown');
      });
    });
  });

  // Same GET /transactions/{reference} envelope confirmed for the
  // 'processing' case during #28's design (see KoraDisburseResponse /
  // KoraPayoutStatusResponse comments) — the 'success'/'failed' terminal
  // shapes here are not independently re-confirmed against a live sandbox
  // response (a live disbursement is a real-money action this environment's
  // tooling refuses), so these mirror verifyCharge's mapping and Kora's
  // documented shape rather than an observed one.
  describe('verifyPayout', () => {
    it('throws, rather than reporting an outcome, when the body is not JSON', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      });
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyPayout('cliqpay-payout-6')).rejects.toThrow(
        /KoraAdapter/,
      );
    });

    it('maps a "success" status to a success outcome with the settled amount', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'ok',
          data: {
            reference: 'cliqpay-payout-1',
            status: 'success',
            amount: '1000.00',
            currency: 'NGN',
            message: 'Transfer successful',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      const result = await adapter.verifyPayout('cliqpay-payout-1');

      expect(result).toEqual({
        status: 'success',
        amount: Money.of(100000n, 'NGN'),
      });
    });

    it('maps a "failed" status to a failed outcome carrying the provider\'s reason', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'ok',
          data: {
            reference: 'cliqpay-payout-2',
            status: 'failed',
            amount: '1000.00',
            currency: 'NGN',
            message: 'Beneficiary account closed',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyPayout('cliqpay-payout-2')).resolves.toEqual({
        status: 'failed',
        reason: 'Beneficiary account closed',
      });
    });

    it('maps Kora\'s "processing" status to a pending outcome', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          status: true,
          message: 'ok',
          data: {
            reference: 'cliqpay-payout-3',
            status: 'processing',
            amount: '1000.00',
            currency: 'NGN',
            message: 'Payout processing',
          },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyPayout('cliqpay-payout-3')).resolves.toEqual({
        status: 'pending',
      });
    });

    it('throws on a non-ok response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, { status: false, message: 'not found' }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyPayout('cliqpay-payout-4')).rejects.toThrow(
        /not found/,
      );
    });

    it('throws a descriptive error on a network failure', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyPayout('cliqpay-payout-5')).rejects.toThrow(
        /ECONNRESET/,
      );
    });
  });

  describe('initiateRefund', () => {
    const params = {
      reference: 'rfd-0a1b2c3d-0000-4000-8000-000000000001-1',
      paymentReference: 'cliqpay-ref-1',
      amount: Money.of(100_000n, 'NGN'),
      reason: 'Wallet balance limit exceeded',
    };

    it('sends the principal as a major-unit decimal, with no webhook_url or completion_status, to the refunds endpoint', async () => {
      fetchMock.mockResolvedValue(
        respondWith('refund.initiate.full_no_completion_status'),
      );
      const adapter = new KoraAdapter(buildConfig());

      await adapter.initiateRefund(params);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://api.korapay.com/merchant/api/v1/refunds/initiate',
      );
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        payment_reference: 'cliqpay-ref-1',
        reference: params.reference,
        amount: '1000.00',
        reason: 'Wallet balance limit exceeded',
      });
    });

    it.each([
      ['refund.initiate.full_no_completion_status', { status: 'accepted' }],
      ['refund.initiate.partial_net_amount', { status: 'accepted' }],
      [
        'refund.initiate.duplicate_reference_same_payment',
        { status: 'already_exists' },
      ],
      [
        'refund.initiate.reuse_failed_reference.2',
        { status: 'already_exists' },
      ],
    ])('maps %s to %o', async (name, expected) => {
      fetchMock.mockResolvedValue(respondWith(name));
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.initiateRefund(params)).resolves.toEqual(expected);
    });

    it.each([
      ['refund.initiate.unknown_payment', 'Transaction not found'],
      [
        'refund.initiate.exceeds_paid',
        "Refund amount can't be more than NGN 1053.75",
      ],
      [
        'refund.initiate.second_refund_immediately',
        'The maximum refundable amount for this transaction is NGN 53.75',
      ],
      [
        'refund.initiate.already_fully_refunded',
        'A full reversal has already been processed for this transaction',
      ],
      [
        'refund.initiate.full_on_remainder_below_100',
        'A full refund cannot be initiated for this transaction. Please enter an amount less than or equal to NGN 53.75',
      ],
      [
        'refund.initiate.retry_after_failed_success',
        'Possible duplicate refund detected, please confirm and try again in 56 seconds',
      ],
      [
        'refund.initiate.missing_reference',
        'One or more fields are invalid. Please fix them and try again.',
      ],
    ])(
      'maps the rejection in %s to rejected with the provider message',
      async (name, message) => {
        fetchMock.mockResolvedValue(respondWith(name));
        const adapter = new KoraAdapter(buildConfig());

        const result = await adapter.initiateRefund(params);

        expect(result).toMatchObject({ status: 'rejected' });
        expect((result as { reason: string }).reason).toContain(
          message.slice(0, 30),
        );
      },
    );

    it('maps a 500 to unknown, not rejected: the provider may have the request', async () => {
      fetchMock.mockResolvedValue(
        respondWith('refund.initiate.reference_too_long'),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.initiateRefund(params)).resolves.toMatchObject({
        status: 'unknown',
      });
    });

    it('maps a network failure to unknown', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.initiateRefund(params)).resolves.toMatchObject({
        status: 'unknown',
      });
    });
  });

  describe('verifyRefund', () => {
    it('reads the refund by its reference', async () => {
      fetchMock.mockResolvedValue(respondWith('refund.get.r1.poll0'));
      const adapter = new KoraAdapter(buildConfig());

      await adapter.verifyRefund('rfd-ref-1');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://api.korapay.com/merchant/api/v1/refunds/rfd-ref-1',
      );
      expect(init.method).toBe('GET');
    });

    it('maps a successful refund to its amount', async () => {
      fetchMock.mockResolvedValue(respondWith('refund.get.r1.poll0'));
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyRefund('rfd-ref-1')).resolves.toEqual({
        status: 'success',
        amount: Money.of(100_000n, 'NGN'),
      });
    });

    it('maps a failed refund', async () => {
      fetchMock.mockResolvedValue(respondWith('refund.get.completion_failed'));
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyRefund('rfd-ref-2')).resolves.toMatchObject({
        status: 'failed',
      });
    });

    it('maps a refund that is not finished to pending', async () => {
      const { response } = refundFixture('refund.get.r1.poll0');
      const body = response.body as { data: Record<string, unknown> };
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          ...body,
          data: { ...body.data, status: 'processing' },
        }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyRefund('rfd-ref-3')).resolves.toEqual({
        status: 'pending',
      });
    });

    it('maps "Refund not found" to not_found', async () => {
      fetchMock.mockResolvedValue(respondWith('refund.get.unknown'));
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyRefund('rfd-ref-4')).resolves.toEqual({
        status: 'not_found',
      });
    });

    it('throws on any other failure so the poll retries', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(500, { status: false, message: 'Internal server error' }),
      );
      const adapter = new KoraAdapter(buildConfig());

      await expect(adapter.verifyRefund('rfd-ref-5')).rejects.toThrow(
        /Internal server error/,
      );
    });
  });
});
