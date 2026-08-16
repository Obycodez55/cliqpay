# ADR-0010: `reference` stays a single field — scoped by sender, matched by fingerprint

**Status:** accepted
**Date:** 2026-08-01

## Context

docs/architecture.md §5 defines `transactions.reference` as "Cliqpay's own
idempotency key (client-supplied for client-initiated ops)", globally unique.
Phase 2 built the funding flow on exactly that: the client supplies
`reference`, the unique constraint gates the provider call, and a repeat
request returns the original result. ADR-0007 then established that for
funding the same value is also sent to Kora and mirrored into
`provider_reference`, because Kora returns no distinct identifier of its own.

So one client-supplied string is simultaneously the idempotency key, the
transaction's identity, and the provider correlator.

Designing Phase 3's transfer endpoint against that shape surfaced two
defects in the existing implementation, both of which get materially worse
when the operation moves money between two users rather than crediting one:

1. **The replay lookup is not scoped to the caller.** `PaymentsService`
   looks up the reference and returns the stored result to whoever asked. If
   user B submits a `reference` user A already used, B receives A's checkout
   URL. Ported unchanged to transfers, B's transfer would silently never
   happen and B would receive A's transfer details — amount and recipient
   included.

2. **A replay is never checked against the request that produced it.**
   Nothing compares the incoming amount to the stored one. A client that
   sends `ref=X, ₦1,000 → Ada` and later reuses `ref=X` for
   `₦50,000 → Bola` receives the original ₦1,000-to-Ada result with a `200`.
   Nothing moved, nothing errored, and the client believes ₦50,000 arrived.

The wider question this raised is whether the conflation itself is the
mistake. It is worth being precise about the two conventions in play:

- **The payment-gateway convention** — Paystack, Flutterwave and Kora all
  take a merchant-supplied reference on initialize and use that same value
  for verification and reconciliation. This is what §5 chose, and it is
  standard for this class of integration.
- **The generic-API convention (Stripe)** — `Idempotency-Key` is a header,
  scoped per API key, expiring after roughly 24 hours, explicitly *not* the
  object's identity; the object gets its own server-generated id.

The Stripe split exists to buy four properties. Conflating the fields keeps
one of them and silently drops three:

| Property                        | Split model     | Conflated (today)      |
| ------------------------------- | --------------- | ---------------------- |
| Per-caller scope                | per API key     | global — defect 1      |
| Same key, different body        | rejected        | silent replay — defect 2 |
| Expiry                          | ~24h            | permanent              |
| Customer-facing identity        | server-generated | the client's raw string |

## Decision

Keep `reference` as a single field. Restore the two missing properties that
actually cause harm:

- **Sender-scoped replay.** A reference that exists and belongs to the caller
  replays the original result. One that exists and belongs to someone else
  returns `409 Conflict` — never a replay, never another user's data.
- **Request fingerprint.** A replay returns the original result only if the
  meaningful request parameters match what produced it. A divergent replay
  returns `422` rather than a misleading success.

The Phase 2 funding path is corrected in the same change; leaving a known
misroute in a shipped flow while fixing its copy in a new one is not a
defensible split.

Clients should use UUIDs for `reference`. The existing DTO format constraint
already nudges toward this, and it is documented at the API surface.

## Alternatives considered

- **Composite uniqueness on `(user_id, reference)`.** Makes cross-user
  collision impossible by construction. Rejected: `transactions` has no
  `user_id` column, and participants deliberately live in `ledger_entries` —
  §5 states outright that the denormalized wallet columns are not the source
  of truth for who was involved. Adding a user column to support idempotency
  would partly contradict that.
- **Server-namespacing the stored value** as `"{userId}:{clientRef}"`.
  Guarantees isolation without a new column, but `reference` stops being the
  client's own value and starts leaking user ids into an externally visible,
  provider-facing field.
- **Splitting into `reference` + `idempotency_key` (the Stripe model).**
  Genuinely cleaner, and it is the option that would let `reference` become a
  server-generated, user-facing identifier — today a user's statement shows
  the client's retry token as their permanent transaction id. Rejected *for
  now* on cost: a migration, a backfill of existing rows, a change to the
  shipped Phase 2 funding contract, and an amendment to §5, in exchange for
  properties 3 and 4, which are cosmetic at present. Noted deliberately: if
  user-facing transaction identifiers are ever wanted, doing this before
  Phases 4 and 5 add withdrawal and chargeback rows is cheaper than after.

## Consequences

- A reference burned by another user is burned for the caller too. With UUID
  references this never occurs in practice; with sequential client-side
  references it would, which is why the guidance is explicit.
- The fingerprint must be computed over the parameters that define the
  operation, not the whole request body — headers, timestamps and
  client-supplied display fields must not participate, or legitimate retries
  would spuriously `422`.
- Every subsequent money-moving endpoint inherits this contract rather than
  re-deciding it: scoped replay, fingerprint match, `409` on cross-user
  collision, `422` on divergence.
- The two-field split above remains available. Nothing decided here forecloses
  it; it becomes more expensive with each phase that adds a transaction type.
