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
 * A charge that hasn't resolved yet is a distinct outcome from `failed`,
 * not an error — `pending` means "ask again later," so it carries no
 * amount/fee (there's nothing settled yet to report). Kora's real verify
 * endpoint returns `"processing"` for this case, not `"pending"` — see
 * KoraAdapter.verifyCharge.
 */
export type VerifyChargeResult =
  | { status: 'success'; netAmount: Money; providerFee: Money }
  | { status: 'failed' }
  | { status: 'pending' };

/**
 * See docs/architecture.md §3.6 — exactly the methods Phase 2 needs.
 * `initiatePayout()`/`verifyKyc()` are not stubbed here; they arrive with
 * Phase 4/6, not ahead of them (CLAUDE.md's incremental-build rule).
 */
export interface PaymentProviderAdapter {
  initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult>;

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;

  // The self-verify poll path (issue #14) — called for `transactions` rows
  // whose webhook never arrived within the normal window.
  verifyCharge(reference: string): Promise<VerifyChargeResult>;
}

export const PAYMENT_PROVIDER_ADAPTER = Symbol('PAYMENT_PROVIDER_ADAPTER');
