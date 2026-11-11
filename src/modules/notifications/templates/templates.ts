import {
  AccountFrozenPayload,
  BillSplitCompletedPayload,
  ChargebackReceivedPayload,
  EmailVerificationOtpPayload,
  FundingCompletedPayload,
  FundingHeldPayload,
  FundingRefundedPayload,
  MfaChallengeOtpPayload,
  MoneyRequestCreatedPayload,
  MoneyRequestDeclinedPayload,
  MoneyRequestPaidPayload,
  NewFollowerPayload,
  NotificationPayloadMap,
  PasswordResetOtpPayload,
  PhoneVerificationOtpPayload,
  PostCommentPayload,
  PostReactionPayload,
  ScheduledPaymentCreatedPayload,
  ScheduledPaymentUpdatedPayload,
  ScheduledPaymentPausedPayload,
  ScheduledPaymentRunsMissedPayload,
  ScheduledPaymentUpcomingPayload,
  ScheduledPaymentRunFailedPayload,
  ReconciliationMismatchPayload,
  RefundAttentionRequiredPayload,
  SecurityAlertPayload,
  AccountSelfLockedPayload,
  TransferReceivedPayload,
  TransferSentPayload,
  WithdrawalCompletedPayload,
  WithdrawalFailedPayload,
  WithdrawalInitiatedPayload,
} from '../notification-catalog';
import { StepUpAction } from '../../../shared/events/domain-events';
import { renderEmail } from './render-email';

const RECIPIENT_UNABLE_TO_RECEIVE =
  "the recipient can't receive this payment right now";

// A block, the recipient's balance cap and an unavailable recipient read the
// same, as on a live send. Events published before the three were merged
// still carry the old codes.
const SCHEDULE_FAILURE_REASONS: Record<string, string> = {
  insufficient_balance: 'your wallet balance was too low',
  daily_limit_exceeded: 'it would have gone over your daily limit',
  security_cooldown_limit:
    'a recent security change limits what you can send for 24 hours',
  bank_account_cooling:
    'this bank account is new and limited to a small total for its first 24 hours',
  recipient_unable_to_receive: RECIPIENT_UNABLE_TO_RECEIVE,
  recipient_cap: RECIPIENT_UNABLE_TO_RECEIVE,
  blocked: RECIPIENT_UNABLE_TO_RECEIVE,
  recipient_unavailable: RECIPIENT_UNABLE_TO_RECEIVE,
  sender_frozen: 'your account is frozen',
  sender_unverified: 'your account needs identity verification to send',
  bank_account_removed: 'the bank account is no longer saved',
  payout_rejected: 'the bank rejected the payment',
  amount_below_minimum: 'the amount is below the current minimum',
  infrastructure: 'of a problem on our side',
  consecutive_failures: 'its last 3 payments failed',
};

function scheduleReason(reason: string): string {
  return SCHEDULE_FAILURE_REASONS[reason] ?? 'it could not be completed';
}

const CHANGED_FIELD_LABELS: Record<string, string> = {
  nextRunDate: 'next run date',
  endDate: 'end date',
  maxRuns: 'number of runs',
};

function changedLabels(fields: string[]): string {
  return fields.map((field) => CHANGED_FIELD_LABELS[field] ?? field).join(', ');
}

const MISSED_DATES_SHOWN = 5;

function missedDates(dates: string[]): string {
  const shown = dates.slice(0, MISSED_DATES_SHOWN).join(', ');
  const rest = dates.length - MISSED_DATES_SHOWN;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

function missedBody(payload: ScheduledPaymentRunsMissedPayload): string {
  const count = payload.runDates.length;
  return `We couldn't run your ${payload.currency} ${payload.amount} payment to ${payload.counterpartyLabel} on ${missedDates(payload.runDates)} because of a problem on our side, so ${count === 1 ? 'it was' : 'they were'} skipped and not paid.`;
}

function upcomingBody(payload: ScheduledPaymentUpcomingPayload): string {
  const fee = payload.fee
    ? ` plus ${payload.currency} ${payload.fee} in fees`
    : '';
  return `Your ${payload.currency} ${payload.amount}${fee} payment to ${payload.counterpartyLabel} is scheduled for tomorrow (${payload.runDate}), but your wallet balance is ${payload.currency} ${payload.balance}. Add funds so it goes through.`;
}

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

const STEP_UP_PURPOSES: Record<StepUpAction, string> = {
  set_pin: 'set your transaction PIN',
  change_pin: 'change your transaction PIN',
  reset_pin: 'reset your transaction PIN',
  change_password: 'change your password',
  change_email: 'change your email address',
  change_phone: 'change your phone number',
  enroll_totp: 'set up an authenticator app',
  save_bank_account: 'save a bank account',
  raise_daily_limit: 'raise your daily limit',
  unlock_account: 'unlock your account',
};

const ACCOUNT_SELF_LOCKED_MESSAGE =
  'Your account is locked. Sending money is blocked and you were signed out everywhere. To unlock it, reset your password by email, sign in again, then confirm in the app.';

function mfaCodeName(action: MfaChallengeOtpPayload['action']): string {
  return action === 'sign_in'
    ? 'Cliqpay sign-in code'
    : `Cliqpay code to ${STEP_UP_PURPOSES[action]}`;
}

function postNoun(kind: PostCommentPayload['postKind']): string {
  return kind === 'bill_split' ? 'bill split' : 'transaction';
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
  mfa_challenge_otp: (payload: MfaChallengeOtpPayload) => {
    const name = mfaCodeName(payload.action);
    return {
      subject: `Your ${name}`,
      ...renderEmail('mfa_challenge_otp', { ...payload, name }),
    };
  },
  security_alert: (payload: SecurityAlertPayload) => ({
    subject: 'Security alert on your Cliqpay account',
    ...renderEmail('security_alert', {
      ...payload,
      message: payload.lockUrl
        ? `${payload.message} This wasn’t me, lock my account: ${payload.lockUrl}`
        : payload.message,
    }),
  }),
  account_self_locked: (payload: AccountSelfLockedPayload) => ({
    subject: 'Your Cliqpay account is locked',
    ...renderEmail('security_alert', {
      ...payload,
      message: ACCOUNT_SELF_LOCKED_MESSAGE,
    }),
  }),
  funding_completed: (payload: FundingCompletedPayload) => ({
    subject: 'Your Cliqpay wallet has been funded',
    ...renderEmail('funding_completed', payload),
  }),
  funding_held: (payload: FundingHeldPayload) => ({
    subject: `Your ${payload.currency} ${payload.amount} payment is being refunded`,
    ...renderEmail('funding_held', payload),
  }),
  funding_refunded: (payload: FundingRefundedPayload) => ({
    subject: `Your ${payload.currency} ${payload.amount} refund has been sent`,
    ...renderEmail('funding_refunded', payload),
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
  withdrawal_initiated: (payload: WithdrawalInitiatedPayload) => ({
    subject: `Your withdrawal of ${payload.currency} ${payload.amount} is on its way`,
    ...renderEmail('withdrawal_initiated', payload),
  }),
  scheduled_payment_created: (payload: ScheduledPaymentCreatedPayload) => ({
    subject: `You scheduled ${payload.currency} ${payload.amount} for ${payload.startDate}`,
    ...renderEmail('scheduled_payment_created', payload),
  }),
  scheduled_payment_updated: (payload: ScheduledPaymentUpdatedPayload) => ({
    subject: `Your scheduled payment to ${payload.counterpartyLabel} was changed`,
    ...renderEmail('scheduled_payment_updated', {
      ...payload,
      changedText: changedLabels(payload.changedFields),
    }),
  }),
  scheduled_payment_paused: (payload: ScheduledPaymentPausedPayload) => ({
    subject: `Your scheduled payment to ${payload.counterpartyLabel} was paused`,
    ...renderEmail('scheduled_payment_paused', {
      ...payload,
      reasonText: scheduleReason(payload.reason),
    }),
  }),
  withdrawal_completed: (payload: WithdrawalCompletedPayload) => ({
    subject: `Your withdrawal of ${payload.currency} ${payload.amount} is complete`,
    ...renderEmail('withdrawal_completed', payload),
  }),
  withdrawal_failed: (payload: WithdrawalFailedPayload) => ({
    subject: `Your withdrawal of ${payload.currency} ${payload.amount} failed`,
    ...renderEmail('withdrawal_failed', payload),
  }),
  chargeback_received: (payload: ChargebackReceivedPayload) => ({
    subject: `A chargeback of ${payload.currency} ${payload.amount} was recorded on your account`,
    ...renderEmail('chargeback_received', payload),
  }),
  account_frozen: (payload: AccountFrozenPayload) => ({
    subject: 'Your Cliqpay account has been restricted',
    ...renderEmail('account_frozen', payload),
  }),
  reconciliation_mismatch: (payload: ReconciliationMismatchPayload) => ({
    subject: `Reconciliation mismatch: ${payload.provider}/${payload.currency}`,
    ...renderEmail('reconciliation_mismatch', payload),
  }),
  refund_attention_required: (payload: RefundAttentionRequiredPayload) => ({
    subject: `Refund needs attention: ${payload.currency} ${payload.amount} (${payload.reason})`,
    ...renderEmail('refund_attention_required', payload),
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
    ...(payload.lockUrl && { data: { lockUrl: payload.lockUrl } }),
  }),
  account_self_locked: () => ({
    title: 'Your account is locked',
    body: ACCOUNT_SELF_LOCKED_MESSAGE,
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
  bill_split_completed: (payload: BillSplitCompletedPayload) => ({
    title: 'Split complete',
    body: `Everyone has paid their share of "${payload.description}".`,
    data: { billSplitId: payload.billSplitId },
  }),
  scheduled_payment_run_failed: (
    payload: ScheduledPaymentRunFailedPayload,
  ) => ({
    title: 'Scheduled payment failed',
    body: `Your ${payload.currency} ${payload.amount} payment to ${payload.counterpartyLabel} on ${payload.runDate} failed because ${scheduleReason(payload.reason)}.`,
    data: { scheduledPaymentId: payload.scheduledPaymentId },
  }),
  scheduled_payment_runs_missed: (
    payload: ScheduledPaymentRunsMissedPayload,
  ) => ({
    title: 'Scheduled payments skipped',
    body: missedBody(payload),
    data: { scheduledPaymentId: payload.scheduledPaymentId },
  }),
  scheduled_payment_upcoming: (payload: ScheduledPaymentUpcomingPayload) => ({
    title: 'Low balance for tomorrow’s payment',
    body: upcomingBody(payload),
    data: { scheduledPaymentId: payload.scheduledPaymentId },
  }),
  scheduled_payment_paused: (payload: ScheduledPaymentPausedPayload) => ({
    title: 'Scheduled payment paused',
    body: `Your ${payload.currency} ${payload.amount} payment to ${payload.counterpartyLabel} was paused because ${scheduleReason(payload.reason)}.`,
    data: { scheduledPaymentId: payload.scheduledPaymentId },
  }),
  new_follower: (payload: NewFollowerPayload) => ({
    title: 'New follower',
    body: `${payload.followerUsername} started following you.`,
    data: { followerUserId: payload.followerUserId },
  }),
  post_comment: (payload: PostCommentPayload) => ({
    title: 'New comment',
    body: `${payload.commenterUsername} commented on your ${postNoun(payload.postKind)}.`,
    data: {
      transactionId: payload.transactionId,
      postKind: payload.postKind,
      commentId: payload.commentId,
    },
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
  funding_held: (payload: FundingHeldPayload) => ({
    title: 'Payment being refunded',
    body: `Your ${payload.currency} ${payload.amount} payment would take your wallet over its ${payload.currency} ${payload.cap} limit, so it is being refunded. Verify your identity to raise your limit.`,
    data: { amount: payload.amount, currency: payload.currency },
    dedupeKey: payload.reference,
  }),
  funding_refunded: (payload: FundingRefundedPayload) => ({
    title: 'Payment refunded',
    body: `${payload.currency} ${payload.amount} has been refunded to the account you paid from.`,
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
      ...(payload.note ? { note: payload.note } : {}),
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
      ...(payload.note ? { note: payload.note } : {}),
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
  bill_split_completed: (payload: BillSplitCompletedPayload) => ({
    title: 'Split complete',
    body: `Everyone has paid their share of "${payload.description}".`,
    data: {
      billSplitId: payload.billSplitId,
      total: payload.total,
      currency: payload.currency,
    },
    dedupeKey: payload.billSplitId,
  }),
  scheduled_payment_created: (payload: ScheduledPaymentCreatedPayload) => ({
    title: 'Payment scheduled',
    body: `${payload.currency} ${payload.amount} will be sent to ${payload.counterpartyLabel} on ${payload.startDate}.`,
    data: {
      scheduledPaymentId: payload.scheduledPaymentId,
      amount: payload.amount,
      currency: payload.currency,
      counterpartyLabel: payload.counterpartyLabel,
      startDate: payload.startDate,
    },
    dedupeKey: payload.scheduledPaymentId,
  }),
  scheduled_payment_updated: (payload: ScheduledPaymentUpdatedPayload) => ({
    title: 'Scheduled payment changed',
    body: `Your ${payload.currency} ${payload.amount} payment to ${payload.counterpartyLabel} was changed (${changedLabels(payload.changedFields)}).`,
    data: {
      scheduledPaymentId: payload.scheduledPaymentId,
      amount: payload.amount,
      currency: payload.currency,
      counterpartyLabel: payload.counterpartyLabel,
      changedFields: payload.changedFields,
    },
    dedupeKey: payload.changeId,
  }),
  scheduled_payment_run_failed: (
    payload: ScheduledPaymentRunFailedPayload,
  ) => ({
    title: 'Scheduled payment failed',
    body: `Your ${payload.currency} ${payload.amount} payment to ${payload.counterpartyLabel} on ${payload.runDate} failed because ${scheduleReason(payload.reason)}.`,
    data: {
      scheduledPaymentId: payload.scheduledPaymentId,
      runId: payload.runId,
      reason: payload.reason,
      amount: payload.amount,
      currency: payload.currency,
      counterpartyLabel: payload.counterpartyLabel,
      runDate: payload.runDate,
    },
    dedupeKey: payload.runId,
  }),
  scheduled_payment_runs_missed: (
    payload: ScheduledPaymentRunsMissedPayload,
  ) => ({
    title: 'Scheduled payments skipped',
    body: missedBody(payload),
    data: {
      scheduledPaymentId: payload.scheduledPaymentId,
      runId: payload.runId,
      runDates: payload.runDates,
      amount: payload.amount,
      currency: payload.currency,
      counterpartyLabel: payload.counterpartyLabel,
    },
    dedupeKey: payload.runId,
  }),
  scheduled_payment_upcoming: (payload: ScheduledPaymentUpcomingPayload) => ({
    title: 'Low balance for tomorrow’s payment',
    body: upcomingBody(payload),
    data: {
      scheduledPaymentId: payload.scheduledPaymentId,
      runDate: payload.runDate,
      amount: payload.amount,
      balance: payload.balance,
      currency: payload.currency,
      counterpartyLabel: payload.counterpartyLabel,
    },
    dedupeKey: `${payload.scheduledPaymentId}:${payload.runDate}`,
  }),
  scheduled_payment_paused: (payload: ScheduledPaymentPausedPayload) => ({
    title: 'Scheduled payment paused',
    body: `Your ${payload.currency} ${payload.amount} payment to ${payload.counterpartyLabel} was paused because ${scheduleReason(payload.reason)}. Resume it in the app when you're ready.`,
    data: {
      scheduledPaymentId: payload.scheduledPaymentId,
      reason: payload.reason,
      amount: payload.amount,
      currency: payload.currency,
      counterpartyLabel: payload.counterpartyLabel,
    },
    dedupeKey: payload.changeId,
  }),
  new_follower: (payload: NewFollowerPayload) => ({
    title: 'New follower',
    body: `${payload.followerUsername} started following you.`,
    data: {
      followerUserId: payload.followerUserId,
      followerUsername: payload.followerUsername,
    },
    // Keyed on the pair, not the follow event, so following, unfollowing
    // and following again never stacks a second row.
    dedupeKey: `${payload.followerUserId}:${payload.userId}`,
  }),
  post_reaction: (payload: PostReactionPayload) => ({
    title: 'New reaction',
    body: `${payload.reactorUsername} reacted to your ${postNoun(payload.postKind)}.`,
    data: {
      transactionId: payload.transactionId,
      postKind: payload.postKind,
      reactorUserId: payload.reactorUserId,
      reactorUsername: payload.reactorUsername,
    },
    // One row per reactor per post, so changing or re-adding a reaction
    // never stacks a second notification.
    dedupeKey: `${payload.transactionId}:${payload.reactorUserId}`,
  }),
  post_comment: (payload: PostCommentPayload) => ({
    title: 'New comment',
    body: `${payload.commenterUsername} commented on your ${postNoun(payload.postKind)}.`,
    data: {
      transactionId: payload.transactionId,
      postKind: payload.postKind,
      commentId: payload.commentId,
      commenterUserId: payload.commenterUserId,
      commenterUsername: payload.commenterUsername,
    },
    dedupeKey: payload.commentId,
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
