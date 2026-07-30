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

  // `data` is the provider's own payload (the parsed `data` field of a
  // webhook body, for Kora) — the adapter re-derives the signature from it
  // and compares, rather than the caller pre-computing anything.
  verifyWebhookSignature(data: unknown, signature: string): boolean;
}

export const PAYMENT_PROVIDER_ADAPTER = Symbol('PAYMENT_PROVIDER_ADAPTER');
