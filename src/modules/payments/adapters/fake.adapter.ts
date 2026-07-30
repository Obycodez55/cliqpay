import { createHmac } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentProviderAdapter,
} from './payment-provider.interface';
import { maybeThrowFakePaymentFailure } from '../internal/errors';

// Not config-injected — a fixed, in-memory secret is all a fake needs.
// Deliberately the same HMAC-SHA256-over-JSON.stringify(data) scheme
// KoraAdapter uses (see docs/architecture.md §10, "contract tests ... confirm
// the two stay in sync"), just against a fake key instead of a real one.
const FAKE_SECRET_KEY = 'fake-kora-secret-key';

@Injectable()
export class FakeAdapter implements PaymentProviderAdapter {
  readonly initiated: InitiatePaymentParams[] = [];

  // async with nothing to await, deliberately: the sentinel throw below has
  // to reach a caller doing `.catch()` without `await` as a rejection, which
  // a synchronous throw from a Promise-returning function would escape.
  // eslint-disable-next-line @typescript-eslint/require-await
  async initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult> {
    maybeThrowFakePaymentFailure(params.reference);
    this.initiated.push(params);
    return {
      checkoutUrl: `https://fake-checkout.cliqpay.test/${params.reference}`,
    };
  }

  verifyWebhookSignature(data: unknown, signature: string): boolean {
    const expected = createHmac('sha256', FAKE_SECRET_KEY)
      .update(JSON.stringify(data))
      .digest('hex');
    return expected === signature;
  }
}
