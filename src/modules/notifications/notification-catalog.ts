export type NotificationChannel = 'email' | 'sms' | 'push';

// Delivered as a clickable link, not a typed code — the token is a long,
// opaque value (see VerificationCode entity), so the payload carries the
// full URL rather than a bare code the user would type in.
export interface EmailVerificationOtpPayload {
  userId: string;
  email: string;
  verificationUrl: string;
  expiresInMinutes: number;
}

export interface PhoneVerificationOtpPayload {
  userId: string;
  phone: string;
  code: string;
  expiresInMinutes: number;
}

// Delivered as a clickable link, not a typed code — same reasoning as
// EmailVerificationOtpPayload above.
export interface PasswordResetOtpPayload {
  userId: string;
  email: string;
  resetUrl: string;
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
}

export interface FundingCompletedPayload {
  userId: string;
  email: string;
  amount: string;
  currency: string;
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
  reconciliation_mismatch: ReconciliationMismatchPayload;
}

// Notification type -> channel(s). Dispatch mechanism (fire-and-forget vs
// synchronous) is the caller's choice, not encoded here — email_verification_otp
// is sent both ways depending on which endpoint triggers it.
export const NOTIFICATION_CATALOG = {
  email_verification_otp: { channels: ['email'] },
  phone_verification_otp: { channels: ['sms'] },
  password_reset_otp: { channels: ['email'] },
  mfa_challenge_otp: { channels: ['email'] },
  security_alert: { channels: ['email', 'push'] },
  funding_completed: { channels: ['email'] },
  reconciliation_mismatch: { channels: ['email'] },
} as const satisfies Record<
  keyof NotificationPayloadMap,
  { channels: readonly NotificationChannel[] }
>;

export type NotificationType = keyof typeof NOTIFICATION_CATALOG;
