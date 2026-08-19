export interface DomainEventEnvelope<
  TName extends string = string,
  TPayload = unknown,
> {
  name: TName;
  payload: TPayload;
  occurredAt: Date;
}

// Not importing notifications' own payload types below — auth (core) can't
// import from notifications (peripheral), see docs/architecture.md §10 — so
// each event is a structurally-compatible shape published by name; the
// notifications processors match by job name, not by type.

export const SECURITY_ALERT_EVENT = 'security_alert';

export interface SecurityAlertEventPayload {
  userId: string;
  email: string;
  message: string;
  occurredAt: string; // ISO-8601 — see notifications' SecurityAlertPayload
}

export const MFA_CHALLENGE_OTP_EVENT = 'mfa_challenge_otp';

export interface MfaChallengeOtpEventPayload {
  userId: string;
  email: string;
  code: string;
  expiresInMinutes: number;
}

// Carries a link, not a bare code — the token is long and opaque, meant to
// be clicked, never typed (unlike the MFA challenge above).
export const EMAIL_VERIFICATION_OTP_EVENT = 'email_verification_otp';

export interface EmailVerificationOtpEventPayload {
  userId: string;
  email: string;
  code: string;
  expiresInMinutes: number;
}

// Carries a bare 6-digit code, not a link — delivered over SMS, meant to be
// typed (same shape as the MFA challenge above, unlike email verification).
export const PHONE_VERIFICATION_OTP_EVENT = 'phone_verification_otp';

export interface PhoneVerificationOtpEventPayload {
  userId: string;
  phone: string;
  code: string;
  expiresInMinutes: number;
}

// Carries a link, not a bare code — same reasoning as email verification.
export const PASSWORD_RESET_OTP_EVENT = 'password_reset_otp';

export interface PasswordResetOtpEventPayload {
  userId: string;
  email: string;
  code: string;
  expiresInMinutes: number;
}

export const FUNDING_COMPLETED_EVENT = 'funding_completed';

export interface FundingCompletedEventPayload {
  userId: string;
  email: string;
  amount: string; // decimal display string (Money.toDecimalString()), not minor units
  currency: string;
  reference: string; // funding transaction reference — see notifications' FundingCompletedPayload
}

export const TRANSFER_SENT_EVENT = 'transfer_sent';

export interface TransferSentEventPayload {
  userId: string;
  email: string;
  counterpartyUsername: string;
  amount: string; // decimal display string (Money.toDecimalString())
  currency: string;
  reference: string;
}

export const TRANSFER_RECEIVED_EVENT = 'transfer_received';

export interface TransferReceivedEventPayload {
  userId: string;
  email: string;
  counterpartyUsername: string;
  amount: string; // decimal display string (Money.toDecimalString())
  currency: string;
  reference: string;
}

export const MONEY_REQUEST_CREATED_EVENT = 'money_request_created';

export interface MoneyRequestCreatedEventPayload {
  userId: string; // the payer being asked
  email: string;
  counterpartyUsername: string; // requester's username
  amount: string; // decimal display string (Money.toDecimalString())
  currency: string;
  note: string | null;
  // The money request's own id — the in-app channel's dedupe_key, same
  // reasoning as TransferSentEventPayload's reference.
  moneyRequestId: string;
}

export const MONEY_REQUEST_DECLINED_EVENT = 'money_request_declined';

export interface MoneyRequestDeclinedEventPayload {
  userId: string; // the requester, notified their request was declined
  email: string;
  counterpartyUsername: string; // payer's username
  amount: string; // decimal display string (Money.toDecimalString())
  currency: string;
  moneyRequestId: string;
}

export const MONEY_REQUEST_PAID_EVENT = 'money_request_paid';

export interface MoneyRequestPaidEventPayload {
  userId: string; // the requester, notified their request was paid
  email: string;
  counterpartyUsername: string; // payer's username
  amount: string; // decimal display string (Money.toDecimalString())
  currency: string;
  note: string | null;
  moneyRequestId: string;
}

export const WITHDRAWAL_INITIATED_EVENT = 'withdrawal_initiated';

export interface WithdrawalInitiatedEventPayload {
  userId: string;
  email: string;
  amount: string; // decimal display string (Money.toDecimalString()), not minor units
  currency: string;
  bankName: string;
  accountNumberLast4: string;
  reference: string; // withdrawal transaction reference — see notifications' WithdrawalInitiatedPayload
}

export const RECONCILIATION_MISMATCH_EVENT = 'reconciliation_mismatch';

export interface ReconciliationMismatchEventPayload {
  email: string;
  provider: string;
  currency: string;
  ledgerBalance: string; // decimal display string, ledger-derived float_<ccy> balance
  providerBalance: string; // decimal display string, provider-reported balance
  delta: string; // decimal display string, ledgerBalance - providerBalance
  occurredAt: string; // ISO timestamp
}
