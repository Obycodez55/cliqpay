import { createHmac } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Money } from '../../../shared/primitives/money';
import {
  InitiatePaymentParams,
  InitiatePaymentResult,
  PaymentProviderAdapter,
  VerifyChargeResult,
} from './payment-provider.interface';
import { maybeThrowFakePaymentFailure } from '../internal/errors';
import { extractTopLevelJsonField } from '../internal/raw-json';

// Not config-injected — a fixed, in-memory secret is all a fake needs.
// Deliberately the same HMAC-SHA256-over-JSON.stringify(data) scheme
// KoraAdapter uses (see docs/architecture.md §10, "contract tests ... confirm
// the two stay in sync"), just against a fake key instead of a real one.
const FAKE_SECRET_KEY = 'fake-kora-secret-key';

@Injectable()
export class FakeAdapter implements PaymentProviderAdapter {
  readonly initiated: InitiatePaymentParams[] = [];
  private readonly verifyChargeResults = new Map<string, VerifyChargeResult>();
  private readonly balances = new Map<string, Money>();

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

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const rawData = extractTopLevelJsonField(rawBody, 'data');
    if (!rawData) {
      return false;
    }
    const expected = createHmac('sha256', FAKE_SECRET_KEY)
      .update(rawData)
      .digest('hex');
    return expected === signature;
  }

  // Test-only configuration for the poll path (issue #14) — a reference
  // with no configured result defaults to `pending`, the safe default: an
  // un-configured stale transaction is left alone rather than force-resolved.
  setVerifyChargeResult(reference: string, result: VerifyChargeResult): void {
    this.verifyChargeResults.set(reference, result);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyCharge(reference: string): Promise<VerifyChargeResult> {
    return this.verifyChargeResults.get(reference) ?? { status: 'pending' };
  }

  setBalance(currency: string, balance: Money): void {
    this.balances.set(currency, balance);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getBalance(currency: string): Promise<Money> {
    return this.balances.get(currency) ?? Money.zero(currency);
  }
}
