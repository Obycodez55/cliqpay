import {
  EmailVerificationOtpPayload,
  FundingCompletedPayload,
  MfaChallengeOtpPayload,
  MoneyRequestCreatedPayload,
  MoneyRequestDeclinedPayload,
  MoneyRequestPaidPayload,
  NotificationPayloadMap,
  PasswordResetOtpPayload,
  PhoneVerificationOtpPayload,
  ReconciliationMismatchPayload,
  SecurityAlertPayload,
  TransferReceivedPayload,
  TransferSentPayload,
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

export interface InAppContent {
  title: string;
  body: string;
  data: Record<string, unknown>;
  dedupeKey: string;
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
  transfer_sent: (payload: TransferSentPayload) => ({
    subject: `You sent ${payload.currency} ${payload.amount}`,
    ...renderEmail('transfer_sent', payload),
  }),
  transfer_received: (payload: TransferReceivedPayload) => ({
    subject: `You received ${payload.currency} ${payload.amount}`,
    ...renderEmail('transfer_received', payload),
  }),
  money_request_created: (payload: MoneyRequestCreatedPayload) => ({
    subject: `${payload.counterpartyUsername} requested ${payload.currency} ${payload.amount}`,
    ...renderEmail('money_request_created', payload),
  }),
  money_request_declined: (payload: MoneyRequestDeclinedPayload) => ({
    subject: `Your money request was declined`,
    ...renderEmail('money_request_declined', payload),
  }),
  money_request_paid: (payload: MoneyRequestPaidPayload) => ({
    subject: `${payload.counterpartyUsername} paid your money request`,
    ...renderEmail('money_request_paid', payload),
  }),
  reconciliation_mismatch: (payload: ReconciliationMismatchPayload) => ({
    subject: `Reconciliation mismatch: ${payload.provider}/${payload.currency}`,
    ...renderEmail('reconciliation_mismatch', payload),
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
  transfer_sent: (payload: TransferSentPayload) => ({
    title: 'Money sent',
    body: `You sent ${payload.currency} ${payload.amount} to ${payload.counterpartyUsername}.`,
  }),
  transfer_received: (payload: TransferReceivedPayload) => ({
    title: 'Money received',
    body: `${payload.counterpartyUsername} sent you ${payload.currency} ${payload.amount}.`,
  }),
  money_request_created: (payload: MoneyRequestCreatedPayload) => ({
    title: 'Money request',
    body: `${payload.counterpartyUsername} requested ${payload.currency} ${payload.amount} from you.`,
  }),
  money_request_declined: (payload: MoneyRequestDeclinedPayload) => ({
    title: 'Request declined',
    body: `${payload.counterpartyUsername} declined your request for ${payload.currency} ${payload.amount}.`,
  }),
  money_request_paid: (payload: MoneyRequestPaidPayload) => ({
    title: 'Request paid',
    body: `${payload.counterpartyUsername} paid you ${payload.currency} ${payload.amount}.`,
  }),
};

export const inAppTemplates: {
  [K in keyof NotificationPayloadMap]?: (
    payload: NotificationPayloadMap[K],
  ) => InAppContent;
} = {
  funding_completed: (payload: FundingCompletedPayload) => ({
    title: 'Wallet funded',
    body: `Your wallet was funded with ${payload.currency} ${payload.amount}.`,
    data: { amount: payload.amount, currency: payload.currency },
    dedupeKey: payload.reference,
  }),
  transfer_sent: (payload: TransferSentPayload) => ({
    title: 'Money sent',
    body: `You sent ${payload.currency} ${payload.amount} to ${payload.counterpartyUsername}.`,
    data: {
      amount: payload.amount,
      currency: payload.currency,
      counterpartyUsername: payload.counterpartyUsername,
    },
    dedupeKey: payload.reference,
  }),
  transfer_received: (payload: TransferReceivedPayload) => ({
    title: 'Money received',
    body: `${payload.counterpartyUsername} sent you ${payload.currency} ${payload.amount}.`,
    data: {
      amount: payload.amount,
      currency: payload.currency,
      counterpartyUsername: payload.counterpartyUsername,
    },
    dedupeKey: payload.reference,
  }),
  money_request_created: (payload: MoneyRequestCreatedPayload) => ({
    title: 'Money request',
    body: `${payload.counterpartyUsername} requested ${payload.currency} ${payload.amount} from you.`,
    data: {
      amount: payload.amount,
      currency: payload.currency,
      counterpartyUsername: payload.counterpartyUsername,
      moneyRequestId: payload.moneyRequestId,
    },
    dedupeKey: payload.moneyRequestId,
  }),
  money_request_declined: (payload: MoneyRequestDeclinedPayload) => ({
    title: 'Request declined',
    body: `${payload.counterpartyUsername} declined your request for ${payload.currency} ${payload.amount}.`,
    data: {
      amount: payload.amount,
      currency: payload.currency,
      counterpartyUsername: payload.counterpartyUsername,
      moneyRequestId: payload.moneyRequestId,
    },
    dedupeKey: payload.moneyRequestId,
  }),
  money_request_paid: (payload: MoneyRequestPaidPayload) => ({
    title: 'Request paid',
    body: `${payload.counterpartyUsername} paid you ${payload.currency} ${payload.amount}.`,
    data: {
      amount: payload.amount,
      currency: payload.currency,
      counterpartyUsername: payload.counterpartyUsername,
      moneyRequestId: payload.moneyRequestId,
    },
    dedupeKey: payload.moneyRequestId,
  }),
  security_alert: (payload: SecurityAlertPayload) => ({
    title: 'Security alert',
    body: payload.message,
    data: { message: payload.message },
    // No stable event id exists on this payload (unlike funding's
    // transaction reference), so the dedupe_key is derived instead:
    // occurredAt rounded to the minute, combined with the message text. A
    // genuine retry of the same publish lands in the same 60s bucket with
    // identical text; two distinct alerts for the same user essentially
    // never share both.
    dedupeKey: `${payload.occurredAt.slice(0, 16)}:${payload.message}`,
  }),
};
