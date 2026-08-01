# ADR-0013: In-app notifications — a persisted channel, per-channel dispatch, 180-day retention

**Status:** accepted
**Date:** 2026-08-01

## Context

docs/architecture.md §6 Phase 3 lists "In-app notifications" without
defining them. The `notifications` module built in Phase 1 has email, SMS and
push channels and a `push_tokens` table, but **stores no notifications at
all** — every existing channel is fire-and-forget: render a template, hand it
to an adapter, done. Nothing is persisted and nothing is read back.

An in-app notification inverts that. The row *is* the product, it has to
still make sense weeks later, and it is read over an API rather than
delivered once.

Building it surfaced a defect in the existing dispatch path.
`NotificationService.send()` fans out with `await Promise.all(...)`, and the
domain-events queue is configured `attempts: 5` with exponential backoff. A
single channel failing therefore fails the whole job and retries *every*
channel: an FCM blip while sending a `security_alert` (channels
`['email', 'push']`) sends up to five duplicate security emails. That is live
today. Adding a persisted channel makes it worse — a retry would insert a
duplicate notification row, and unlike a duplicate email, that one does not
go away.

Auditing the existing catalog against a persisted channel also exposed that
not every notification type can have one. `reconciliation_mismatch` carries
no `userId` at all — only an ops email address. It is not addressed to a
user, and a stored notification has to belong to someone.

## Decision

**In-app is a fourth channel** in the existing `notifications` module, not a
new module. The catalog's type-to-channels mapping is unchanged in shape; the
in-app "sender" writes a row instead of calling an external service.

**Row contents:** `type`, a structured `data` jsonb payload, and `title` /
`body` rendered at write time. Both, not either.

**`data` never carries secrets.** No OTPs, no tokens, no reset URLs, no PINs.
Notification rows are long-lived and returned over a list endpoint.

**Eligibility is enforced at compile time** for the mechanical half: the
catalog is typed so any entry routing to `in_app` must have a payload
extending `{ userId: string }`. The no-secrets half stays a documented review
rule, since no type system distinguishes an OTP string from a username.
`reconciliation_mismatch` stays email-only to ops.

**Dispatch becomes one job per channel.** Each channel retries on its own
budget; no channel can cause another's redelivery. Paired with a
`(user_id, type, dedupe_key)` unique constraint on notification rows, so a
worker that writes a row and dies before acking cannot double-insert.

**Read state** is a nullable `read_at` timestamp. The API surface is a
cursor-paginated list (reusing the existing opaque-cursor helper), an
unread-count endpoint for the badge, and a bulk mark-read. No delete or
archive. Every query is scoped by the authenticated user id *in the WHERE
clause*, not checked after fetching.

**Retention: delete anything older than 180 days**, regardless of read
state, via a scheduled job shipped with the channel.

**No realtime transport.** Delivery stays push-triggers-refetch per §9,
supplemented by foreground polling of the unread count.

## Alternatives considered

- **Rendered text only, or structured data only.** Rejected in favour of
  both. Rendered-only freezes the row: no deep linking, since "Ada sent you
  ₦5,000" cannot be opened without the transaction id as structured data.
  Structured-only requires every client to implement a renderer for every
  type, so a type shipped after a client renders as nothing. The duplication
  is real; the staleness cost is not, because a notification *should* say
  what it said when it fired.
- **`Promise.allSettled` instead of per-channel jobs.** Simpler, and it does
  stop one channel failing another — but it removes retry entirely, so a
  transient email-provider 503 silently drops the notification forever.
- **A dedupe key alone, keeping `Promise.all`.** Fixes the visible symptom
  (duplicate rows) while leaving duplicate emails in place.
- **A generic notification feed built now, fanned out from every event.**
  Rejected as premature: for transfers it is a second copy of transaction
  history, with a consistency problem between the two. A generic feed earns
  its cost in Phase 7, where reactions, comments and follows produce events
  that have no home in transaction history. Building it now means designing
  it against one event type and guessing at the social layer's shape.
- **Deferring retention until volume warrants.** Rejected, and this is the
  opposite call from money-request expiry (ADR-0012) for a specific reason: a
  retention job's cost is dominated by its first run. Shipped now it deletes
  a thin daily increment forever; shipped in two years its first execution
  deletes tens of millions of rows, with the bloat and vacuum pressure that
  implies, on a table users are actively reading. Deferring does not save the
  work, it makes the same work more dangerous.
- **A read/unread retention tier** (e.g. 90 days read, 180 unread). Rejected:
  a 180-day-old unread notification is worth no more than a read one, and two
  thresholds means two predicates and two indexes for no user-visible gain.
- **WebSockets or SSE for realtime delivery.** Rejected for now, consistent
  with §9's existing default. FCM data messages are delivered to a
  *foregrounded* app, so the realtime path already exists with no new
  infrastructure; foreground polling of the unread count closes the remaining
  gap cheaply. If a concrete need emerges, SSE is the right answer rather
  than WebSockets — notifications are strictly server-to-client, NestJS
  supports it in roughly fifteen lines via an Observable, and it stays plain
  HTTP so the existing auth guard, rate limiting, logging and exception
  filter all apply unchanged. WebSockets' one genuine advantage is
  authenticating in the handshake rather than a query string, which matters
  only for browser `EventSource`; React Native uses fetch-based SSE where
  headers work. Nothing through Phase 11 needs a client-to-server channel.
  Deferring costs nothing structurally: notifications already fan out as
  domain events over Redis-backed BullMQ, so adding a pub/sub bridge later is
  purely additive — no schema change, no API change, no migration.

## Consequences

- The dispatch refactor modifies **shipped Phase 1 and Phase 2 behaviour**,
  so those flows' tests are part of its verification, not just the new
  channel's.
- Long-lived notification rows are a new place for user data to accumulate.
  The no-secrets rule on `data` is a standing review obligation on every new
  notification type, in perpetuity.
- The bulk mark-read endpoint takes a list of ids and is therefore a textbook
  IDOR shape. Cross-user ids must be a silent no-op rather than a `403`, so
  the endpoint does not confirm that a row exists.
- Adding a realtime transport later requires no change to anything decided
  here. Should it happen, it needs Redis pub/sub for multi-instance fanout,
  and every rolling deploy will drop all connections and trigger a reconnect
  stampede — worth planning for at that point, not now.
