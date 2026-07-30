import { Money } from '../../../shared/primitives/money';

export interface InitiatePaymentParams {
  reference: string;
  amount: Money;
  customerEmail: string;
}

export interface InitiatePaymentResult {
  checkoutUrl: string;
}

/**
 * See docs/architecture.md §3.6 — exactly the two methods Phase 2 needs.
 * `initiatePayout()`/`verifyKyc()` are not stubbed here; they arrive with
 * Phase 4/6, not ahead of them (CLAUDE.md's incremental-build rule).
 */
export interface PaymentProviderAdapter {
  initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult>;

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

export const PAYMENT_PROVIDER_ADAPTER = Symbol('PAYMENT_PROVIDER_ADAPTER');
