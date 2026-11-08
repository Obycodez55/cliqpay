import {
  WITHDRAWAL_COMPLETED_EVENT,
  WITHDRAWAL_FAILED_EVENT,
} from '../../../shared/events/domain-events';

export const SCHEDULED_PAYMENT_SETTLEMENT_QUEUE =
  'scheduled-payment-settlement-events';

export const SCHEDULED_PAYMENT_SETTLEMENT_EVENTS = [
  WITHDRAWAL_COMPLETED_EVENT,
  WITHDRAWAL_FAILED_EVENT,
] as const;
