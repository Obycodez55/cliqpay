import {
  DEVICE_REGISTERED_EVENT,
  TRANSFER_SENT_EVENT,
} from '../../../shared/events/domain-events';

export const RISK_EVENTS_QUEUE = 'risk-events';
export const RISK_REVIEW_OVERDUE_QUEUE = 'risk-review-overdue';

export const RISK_SUBSCRIBED_EVENTS = [
  TRANSFER_SENT_EVENT,
  DEVICE_REGISTERED_EVENT,
] as const;
