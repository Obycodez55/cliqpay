export type NotificationChannel = 'email' | 'sms' | 'push' | 'in_app';

export interface EmailVerificationOtpPayload {
  userId: string;
  email: string;
  code: string;
  expiresInMinutes: number;
}

export interface PhoneVerificationOtpPayload {
  userId: string;
  phone: string;
  code: string;
  expiresInMinutes: number;
}

export interface PasswordResetOtpPayload {
  userId: string;
  email: string;
  code: string;
  expiresInMinutes: number;
}

export interface MfaChallengeOtpPayload {
  userId: string;
  email: string;
  code: string;
  expiresInMinutes: number;
}

export interface SecurityAlertPayload {
  userId: string;
  email: string;
  message: string;
  // ISO-8601 event time, distinct from BullMQ job/dispatch time — the
  // in-app channel's dedupe_key is derived from this (see templates.ts),
  // since this payload carries no other stable event identifier.
  occurredAt: string;
}

export interface FundingCompletedPayload {
  userId: string;
  email: string;
  amount: string;
  currency: string;
  // The funding transaction's own reference — the in-app channel's
  // dedupe_key (see templates.ts), since it's the one stable id a retried
  // publish of the same real-world funding event will always share.
  reference: string;
}

export interface TransferSentPayload {
  userId: string;
  email: string;
  counterpartyUsername: string;
  amount: string;
  currency: string;
  // The transfer's own reference — same dedupe-key reasoning as
  // FundingCompletedPayload above.
  reference: string;
}

export interface TransferReceivedPayload {
  userId: string;
  email: string;
  counterpartyUsername: string;
  amount: string;
  currency: string;
  reference: string;
}

export interface MoneyRequestCreatedPayload {
  userId: string;
  email: string;
  counterpartyUsername: string;
  amount: string;
  currency: string;
  note: string | null;
  moneyRequestId: string;
}

export interface MoneyRequestDeclinedPayload {
  userId: string;
  email: string;
  counterpartyUsername: string;
  amount: string;
  currency: string;
  moneyRequestId: string;
}

export interface MoneyRequestPaidPayload {
  userId: string;
  email: string;
  counterpartyUsername: string;
  amount: string;
  currency: string;
  note: string | null;
  moneyRequestId: string;
}

export interface WithdrawalInitiatedPayload {
  userId: string;
  email: string;
  amount: string;
  currency: string;
  bankName: string;
  accountNumberLast4: string;
  // The withdrawal transaction's own reference — same dedupe-key reasoning
  // as FundingCompletedPayload above.
  reference: string;
}

export interface ReconciliationMismatchPayload {
  email: string;
  provider: string;
  currency: string;
  ledgerBalance: string;
  providerBalance: string;
  delta: string;
  occurredAt: string;
}

export interface NotificationPayloadMap {
  email_verification_otp: EmailVerificationOtpPayload;
  phone_verification_otp: PhoneVerificationOtpPayload;
  password_reset_otp: PasswordResetOtpPayload;
  mfa_challenge_otp: MfaChallengeOtpPayload;
  security_alert: SecurityAlertPayload;
  funding_completed: FundingCompletedPayload;
  transfer_sent: TransferSentPayload;
  transfer_received: TransferReceivedPayload;
  money_request_created: MoneyRequestCreatedPayload;
  money_request_declined: MoneyRequestDeclinedPayload;
  money_request_paid: MoneyRequestPaidPayload;
  withdrawal_initiated: WithdrawalInitiatedPayload;
  reconciliation_mismatch: ReconciliationMismatchPayload;
}

// The in-app channel writes a row addressed to a user (see
// docs/adr/0013-in-app-notifications.md) — a type with no `userId` on its
// payload (reconciliation_mismatch, addressed to ops) has nothing to
// address a row to, so it can never route there. Enforced at compile time
// below; the complementary "data never carries secrets" rule (no OTPs,
// tokens, reset URLs, PINs) has no type-level signal to hang off and stays
// a documented review obligation whenever a new type is added here.
type AllowedChannels<K extends keyof NotificationPayloadMap> =
  NotificationPayloadMap[K] extends { userId: string }
    ? readonly NotificationChannel[]
    : readonly Exclude<NotificationChannel, 'in_app'>[];

export type NotificationCatalogShape = {
  [K in keyof NotificationPayloadMap]: { channels: AllowedChannels<K> };
};

// Notification type -> channel(s). Dispatch mechanism (fire-and-forget vs
// synchronous) is the caller's choice, not encoded here — email_verification_otp
// is sent both ways depending on which endpoint triggers it. OTP/reset-link
// types are never routed to in_app even though their payloads have a
// userId — their content is the secret the no-secrets rule above exists to
// keep out of a long-lived, listable row.
export const NOTIFICATION_CATALOG = {
  email_verification_otp: { channels: ['email'] },
  phone_verification_otp: { channels: ['sms'] },
  password_reset_otp: { channels: ['email'] },
  mfa_challenge_otp: { channels: ['email'] },
  security_alert: { channels: ['email', 'push', 'in_app'] },
  funding_completed: { channels: ['email', 'in_app'] },
  transfer_sent: { channels: ['email', 'push', 'in_app'] },
  transfer_received: { channels: ['email', 'push', 'in_app'] },
  // Cancel is deliberately excluded from this catalog (issue #24) — only
  // create and decline notify.
  money_request_created: { channels: ['email', 'push', 'in_app'] },
  money_request_declined: { channels: ['email', 'push', 'in_app'] },
  money_request_paid: { channels: ['email', 'push', 'in_app'] },
  // Email only for this issue (#28) — push/in_app follow the same pattern
  // as transfer_sent if a later issue asks for them; not scaffolded ahead
  // of that need.
  withdrawal_initiated: { channels: ['email'] },
  reconciliation_mismatch: { channels: ['email'] },
} as const satisfies NotificationCatalogShape;

export type NotificationType = keyof typeof NOTIFICATION_CATALOG;
