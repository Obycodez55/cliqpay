# ADR-0030: An append-only audit log, and a self-declared reviewer identity until the admin panel exists

**Status:** accepted
**Date:** 2026-11-09

## Context

Phase 11 adds human decisions that move or stop money: confirming a fraud
flag, releasing a held withdrawal, resolving a scam case, lifting a
restriction. The CBN's APP-fraud draft (Nov 2025) requires detailed records of
every incident and its handling. Nothing in the codebase records who did what:
the ledger records money, and the Phase 9 change log covers schedules only.

Internal endpoints are guarded by one shared secret (`InternalSecretGuard`),
so any action through them is just "internal". The admin panel with its own
`AdminUser` (§9) will be built before launch and will replace this guard.

## Decision

**`audit_events`, append-only by trigger** (no `UPDATE`/`DELETE`, like
`ledger_entries`). Columns: `id`, `occurredAt`, `actorType`
(`user` | `reviewer` | `system`), `actorId`, `action`, `subjectType`,
`subjectId`, `metadata` (jsonb), `requestId`.

**A fixed vocabulary of actions**, for state changes that matter to security or
an investigation: restrictions added or lifted, flag and case decisions, holds
placed or released, withdrawals put under or taken out of review, self-lock
and unlock, and the security events that start a cooldown (new device,
password, email, phone, MFA or PIN change, bank account saved). Ordinary money
movement is not logged here; the ledger is that record. Reads are not logged.

**`AuditService` in `src/shared/audit/`.** It is infrastructure every module
writes to, like the event bus, not a domain module; putting it in `users` or
`auth` would make them a dependency of `risk`, `withdrawals` and the rest.

**Written in the caller's transaction.** `record(manager, event)` takes the
caller's `EntityManager`, so the audit row commits or rolls back with the
action it describes. It is not a domain event: events publish after commit
and can be lost.

**Interim reviewer identity.** `InternalSecretGuard` keeps the shared secret
and additionally requires an `X-Reviewer-Id` header, which it puts on the
request; review actions record it as `actor: { type: 'reviewer', id }`. The
identity is self-declared: anyone with the secret can claim any id. This is
accepted only until `AdminUser` exists, and replacing it is a launch blocker.
The disputes endpoints move to the same header.

## Alternatives considered

- **A key per reviewer, resolved by the guard.** Real attribution, but work
  the admin panel throws away within months.
- **A minimal `AdminUser` now.** The §9 design is a phase of its own.
- **Async audit via domain events.** An action could commit with its audit
  record lost.
- **Logging reads.** An NDPA question for launch, not a fraud-control need.

## Consequences

- The `actor` shape is final: swapping the guard for `AdminUser` changes no
  schema and no call site.
- Until then the audit trail proves what happened and when, not who did it.
- Every Phase 11 write path takes a manager it can pass to `record`.
