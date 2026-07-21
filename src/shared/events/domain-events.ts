/**
 * Envelope every published domain event shares. Concrete event payload
 * types accumulate here as modules need them — e.g. Phase 2 adds a
 * `FundingCompletedPayload` when the funding module needs to notify Social
 * and Fraud after a deposit lands.
 */
export interface DomainEventEnvelope<
  TName extends string = string,
  TPayload = unknown,
> {
  name: TName;
  payload: TPayload;
  occurredAt: Date;
}

// Published by auth on refresh-token reuse detection (a previous-generation
// token replayed after rotation — see docs/architecture.md §3.7). Deliberately
// not importing notifications' own `NotificationPayloadMap['security_alert']`
// type — auth (core) can't import from notifications (peripheral), see §10 —
// this is the structurally-compatible shape published by name instead;
// notifications' own processor picks it up generically by job name.
export const SECURITY_ALERT_EVENT = 'security_alert';

export interface SecurityAlertEventPayload {
  userId: string;
  email: string;
  message: string;
}
