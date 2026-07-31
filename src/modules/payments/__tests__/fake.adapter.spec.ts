import { createHmac } from 'crypto';
import { FakeAdapter } from '../adapters/fake.adapter';
import { Money } from '../../../shared/primitives/money';

describe('FakeAdapter', () => {
  describe('initiatePayment', () => {
    it('deterministically returns a checkout URL derived from the reference, no network', async () => {
      const adapter = new FakeAdapter();

      const result = await adapter.initiatePayment({
        reference: 'cliqpay-ref-1',
        amount: Money.of(500000n, 'NGN'),
        customerEmail: 'jane@example.com',
      });

      expect(result).toEqual({
        checkoutUrl: 'https://fake-checkout.cliqpay.test/cliqpay-ref-1',
      });
    });

    it('records every call it succeeds on, in memory', async () => {
      const adapter = new FakeAdapter();
      const params = {
        reference: 'cliqpay-ref-1',
        amount: Money.of(500000n, 'NGN'),
        customerEmail: 'jane@example.com',
      };

      await adapter.initiatePayment(params);

      expect(adapter.initiated).toEqual([params]);
    });

    it('fails deterministically when the reference carries the failure sentinel', async () => {
      const adapter = new FakeAdapter();

      await expect(
        adapter.initiatePayment({
          reference: 'cliqpay-fail-ref',
          amount: Money.of(500000n, 'NGN'),
          customerEmail: 'jane@example.com',
        }),
      ).rejects.toThrow(/simulated payment initiation failure/);
      expect(adapter.initiated).toEqual([]);
    });
  });

  describe('verifyWebhookSignature', () => {
    function rawBody(data: unknown): Buffer {
      return Buffer.from(
        JSON.stringify({ event: 'charge.success', data }),
        'utf8',
      );
    }

    it('accepts a signature computed with its own fake secret', () => {
      const adapter = new FakeAdapter();
      const data = { reference: 'cliqpay-ref-1', status: 'success' };
      const signature = createHmac('sha256', 'fake-kora-secret-key')
        .update(JSON.stringify(data))
        .digest('hex');

      expect(adapter.verifyWebhookSignature(rawBody(data), signature)).toBe(
        true,
      );
    });

    it('rejects an arbitrary signature', () => {
      const adapter = new FakeAdapter();

      expect(
        adapter.verifyWebhookSignature(
          rawBody({ reference: 'cliqpay-ref-1' }),
          'not-a-real-signature',
        ),
      ).toBe(false);
    });
  });

  describe('verifyCharge', () => {
    it('defaults to pending for a reference with no configured result', async () => {
      const adapter = new FakeAdapter();

      await expect(adapter.verifyCharge('cliqpay-ref-1')).resolves.toEqual({
        status: 'pending',
      });
    });

    it('returns whatever result was configured for that reference', async () => {
      const adapter = new FakeAdapter();
      adapter.setVerifyChargeResult('cliqpay-ref-1', {
        status: 'success',
        netAmount: Money.of(500000n, 'NGN'),
        providerFee: Money.of(5000n, 'NGN'),
      });

      await expect(adapter.verifyCharge('cliqpay-ref-1')).resolves.toEqual({
        status: 'success',
        netAmount: Money.of(500000n, 'NGN'),
        providerFee: Money.of(5000n, 'NGN'),
      });
    });
  });

  describe('getBalance', () => {
    it('defaults to zero for a currency with no configured balance', async () => {
      const adapter = new FakeAdapter();

      await expect(adapter.getBalance('NGN')).resolves.toEqual(
        Money.zero('NGN'),
      );
    });

    it('returns whatever balance was configured for that currency', async () => {
      const adapter = new FakeAdapter();
      adapter.setBalance('NGN', Money.of(500_000n, 'NGN'));

      await expect(adapter.getBalance('NGN')).resolves.toEqual(
        Money.of(500_000n, 'NGN'),
      );
    });
  });
});
