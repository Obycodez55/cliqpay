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
  verificationUrl: string;
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
