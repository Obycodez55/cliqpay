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

export interface InitiatePayoutParams {
  reference: string;
  amount: Money; // the amount that arrives at the destination bank account
  bankCode: string;
  accountNumber: string;
  accountName: string;
  customerEmail: string;
}

/**
 * A real sandbox disbursement call (issue #28's design, `POST
 * /merchant/api/v1/transactions/disburse`) confirmed Kora's payout API
 * synchronously rejects some failures (invalid bank, invalid account) with
 * an HTTP 409 and `data.status: 'failed'` before any asynchronous
 * processing begins — a distinct, typed outcome from `accepted`, not a
 * thrown error, same reasoning as ResolveBankAccountResult's `not_found`.
 * `accepted` covers the sandbox's `data.status: 'processing'` — final
 * success/failure only arrives on the payout webhook (#29), which this
 * type deliberately doesn't model yet.
 *
 * `unknown` is distinct from `rejected`: a network error, timeout, or any
 * response shape that isn't a confirmed accept/reject means Kora may still
 * have received and be processing the payout. Debit-first (§6 Phase 4)
 * already moved money out of the wallet before this call — reversing on an
 * outcome that isn't actually a confirmed rejection risks crediting the
 * wallet back while the bank transfer still lands, a real double-spend, not
 * just an over-cautious reversal. A caller must never treat `unknown` the
 * same as `rejected`.
 */
export type InitiatePayoutResult =
  | { status: 'accepted' }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; detail: string };

/**
 * See docs/architecture.md §3.6. `verifyKyc()` is not stubbed here; it
 * arrives with Phase 6, not ahead of it (CLAUDE.md's incremental-build
 * rule).
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

  // Issue #28 — called only after LedgerService.postWithdrawal has already
  // committed (debit-first, docs/architecture.md §6 Phase 4); a `rejected`
  // result tells the caller to reverse what was just posted.
  initiatePayout(params: InitiatePayoutParams): Promise<InitiatePayoutResult>;
}

export const PAYMENT_PROVIDER_ADAPTER = Symbol('PAYMENT_PROVIDER_ADAPTER');
