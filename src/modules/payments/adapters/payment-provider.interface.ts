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
 * `not_found` covers both "bank account doesn't exist" and "invalid bank
 * code" — Kora's real resolve endpoint returns the same 4xx/status:false
 * shape for both (see KoraAdapter.resolveBankAccount) and neither is a
 * system failure, so both are a typed outcome rather than a thrown error —
 * same reasoning as VerifyChargeResult above.
 */
export type ResolveBankAccountResult =
  | { status: 'resolved'; bankName: string; accountName: string }
  | { status: 'not_found' };

/**
 * See docs/architecture.md §3.6. `initiatePayout()`/`verifyKyc()` are not
 * stubbed here; they arrive with the rest of Phase 4/6, not ahead of them
 * (CLAUDE.md's incremental-build rule) — `resolveBankAccount()` is the one
 * Phase 4 method issue #27 actually needs.
 */
export interface PaymentProviderAdapter {
  initiatePayment(
    params: InitiatePaymentParams,
  ): Promise<InitiatePaymentResult>;

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;

  // The self-verify poll path (issue #14) — called for `transactions` rows
  // whose webhook never arrived within the normal window.
  verifyCharge(reference: string): Promise<VerifyChargeResult>;

  // The external reconciliation path (issue #15) — the provider's own
  // reported balance for a currency, to compare against float_<ccy>'s
  // ledger-derived balance. Read-only, no posting knowledge here or in any
  // caller (ADR-0008).
  getBalance(currency: string): Promise<Money>;

  // Issue #27 — resolves a bank account against the provider before it's
  // ever persisted, so `bank_accounts.account_name` is always
  // provider-confirmed, never client-supplied.
  resolveBankAccount(
    bankCode: string,
    accountNumber: string,
  ): Promise<ResolveBankAccountResult>;
}

export const PAYMENT_PROVIDER_ADAPTER = Symbol('PAYMENT_PROVIDER_ADAPTER');
