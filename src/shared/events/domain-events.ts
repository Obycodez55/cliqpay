/**
 * Envelope every published domain event shares. Concrete event payload
 * types accumulate here as modules need them — e.g. Phase 2 adds a
 * `FundingCompletedPayload` when the funding module needs to notify Social
 * and Fraud after a deposit lands. Nothing to add yet with zero feature
 * modules built.
 */
export interface DomainEventEnvelope<
  TName extends string = string,
  TPayload = unknown,
> {
  name: TName;
  payload: TPayload;
  occurredAt: Date;
}
