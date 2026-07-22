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
}

export interface NotificationPayloadMap {
  email_verification_otp: EmailVerificationOtpPayload;
  phone_verification_otp: PhoneVerificationOtpPayload;
  password_reset_otp: PasswordResetOtpPayload;
  mfa_challenge_otp: MfaChallengeOtpPayload;
  security_alert: SecurityAlertPayload;
}

/**
 * One-to-many mapping of notification type to the channel(s) it dispatches
 * on — e.g. security_alert fans out to both email and push. `isOtp` marks
 * the types that go through the synchronous, awaited dispatch path rather
 * than fire-and-forget; see docs/architecture.md §10 and issue #1. Grows one
 * entry per notification a module actually needs to send, not ahead of it —
 * only email MFA exists as a concrete method today (architecture.md §3.8),
 * so mfa_challenge_otp only targets email until SMS/security-key MFA ships.
 */
export const NOTIFICATION_CATALOG = {
  email_verification_otp: { channels: ['email'], isOtp: true },
  phone_verification_otp: { channels: ['sms'], isOtp: true },
  password_reset_otp: { channels: ['email'], isOtp: true },
  mfa_challenge_otp: { channels: ['email'], isOtp: true },
  security_alert: { channels: ['email', 'push'], isOtp: false },
} as const satisfies Record<
  keyof NotificationPayloadMap,
  { channels: readonly NotificationChannel[]; isOtp: boolean }
>;

export type NotificationType = keyof typeof NOTIFICATION_CATALOG;
