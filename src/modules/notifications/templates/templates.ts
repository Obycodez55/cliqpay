import {
  EmailVerificationOtpPayload,
  FundingCompletedPayload,
  MfaChallengeOtpPayload,
  NotificationPayloadMap,
  PasswordResetOtpPayload,
  PhoneVerificationOtpPayload,
  SecurityAlertPayload,
} from '../notification-catalog';
import { renderEmail } from './render-email';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface SmsContent {
  body: string;
}

export interface PushContent {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Code-defined, version-controlled templates — not managed in Brevo's
 * dashboard — so copy changes go through normal code review and fake
 * adapters can log the fully-rendered content for test assertions.
 */
export const emailTemplates: {
  [K in keyof NotificationPayloadMap]?: (
    payload: NotificationPayloadMap[K],
  ) => EmailContent;
} = {
  email_verification_otp: (payload: EmailVerificationOtpPayload) => ({
    subject: 'Verify your Cliqpay email address',
    ...renderEmail('email_verification_otp', payload),
  }),
  password_reset_otp: (payload: PasswordResetOtpPayload) => ({
    subject: 'Reset your Cliqpay password',
    ...renderEmail('password_reset_otp', payload),
  }),
  mfa_challenge_otp: (payload: MfaChallengeOtpPayload) => ({
    subject: 'Your Cliqpay sign-in code',
    ...renderEmail('mfa_challenge_otp', payload),
  }),
  security_alert: (payload: SecurityAlertPayload) => ({
    subject: 'Security alert on your Cliqpay account',
    ...renderEmail('security_alert', payload),
  }),
  funding_completed: (payload: FundingCompletedPayload) => ({
    subject: 'Your Cliqpay wallet has been funded',
    ...renderEmail('funding_completed', payload),
  }),
};

export const smsTemplates: {
  [K in keyof NotificationPayloadMap]?: (
    payload: NotificationPayloadMap[K],
  ) => SmsContent;
} = {
  phone_verification_otp: (payload: PhoneVerificationOtpPayload) => ({
    body: `Your Cliqpay verification code is ${payload.code}. Expires in ${payload.expiresInMinutes} minutes.`,
  }),
};

export const pushTemplates: {
  [K in keyof NotificationPayloadMap]?: (
    payload: NotificationPayloadMap[K],
  ) => PushContent;
} = {
  security_alert: (payload: SecurityAlertPayload) => ({
    title: 'Security alert',
    body: payload.message,
  }),
};
