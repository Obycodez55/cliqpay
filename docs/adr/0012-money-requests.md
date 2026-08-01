# ADR-0012: Money requests — derived expiry, exact amount, pair-capped

**Status:** accepted
**Date:** 2026-08-01

## Context

docs/architecture.md §6 Phase 3 lists "Request money from another user"
with no further specification. A money request is the phase's only stateful
object that is not a transaction: it exists in the gap between asking and
being paid, and Phase 8's bill splitting is built directly on top of it
("Each participant receives a payment request").

Three questions had no answer in the design doc.

**How expiry happens.** A request left alone forever is a stale liability —
someone paying a nine-month-old request by accident is a real, unrecoverable
mistake, since P2P transfers have no reversal path (§4.2 reserves chargebacks
for provider-initiated funding reversals only).

**Whether the payer must pay the requested amount exactly.** Allowing partial
or over-payment turns a request into a balance-tracking object with its own
arithmetic.

**How abuse is bounded.** A money request is an unsolicited, addressable
notification with zero cost to the sender — an obvious harassment vector.

A fourth possibility was raised and rejected: gating requests on the social
graph, so a user can only be asked for money by people they are connected to.

## Decision

**State machine.**

```
pending ──pay──────> paid       (creates a linked P2P transfer)
        ──decline──> declined   (payer)
        ──cancel───> cancelled  (requester)
        ──(expiry)─> expired
```

**Expiry is derived, not swept.** An `expires_at` column is set at creation,
7 days out. Status is computed on read; no background job rewrites rows.
Expiry is enforced at pay time, inside the same transaction that posts the
transfer.

**Exact amount only.** The payer settles the requested amount or does not
settle. Paying a request is then a normal P2P transfer with a
`money_request_id` attached, inheriting PIN, idempotency, bounds, locking,
and eligibility unchanged.

**Abuse is bounded per pair.** At most 3 outstanding `pending` requests from
any one requester to any one payer.

**No social-graph gating.** Requests may be sent to any resolvable user.

## Alternatives considered

- **A BullMQ sweeper flipping rows to `expired`.** Rejected: a request is a
  passive object nobody is waiting on, so the worker would exist purely to
  rewrite a column the query can compute. It would not remove the pay-time
  check either — that has to happen inside the posting transaction
  regardless — so the sweeper is redundant rather than authoritative. This is
  deliberately the opposite conclusion from the notification retention job
  (ADR-0013), and for a specific reason: retention gets harder the longer it
  is deferred, expiry does not.
- **Partial or over-payment.** Rejected — that is precisely Phase 8's bill
  splitting, and building a weaker version of it here means two
  amount-tracking mechanisms to reconcile later.
- **A daily rate limit on requests instead of a pair cap.** Rejected: a daily
  allowance can still be aimed entirely at one victim. The pair cap makes
  targeted harassment structurally impossible while leaving normal usage
  untouched.
- **Restricting requests to connected users.** Rejected on three independent
  grounds. Phase 7 designs *follow/unfollow*, which is asymmetric and needs
  no consent — a harasser simply follows first, so it gates nothing; making
  it a real consent signal would require mutual-follow, a different graph
  than the one designed. Phase 8 sends payment requests to bill-split
  participants, who are frequently not followers, so the gate would either
  break bill splitting or need a bypass that renders it meaningless. And the
  graph is four phases away, so Phase 3 ships requests ungated regardless —
  making the restriction a capability removal later, which is worse than
  never granting it. The protective instinct is instead met by the pair cap
  now, and by a *soft* filter in Phase 7 (requests from non-followed users
  land in a separate bucket and do not push-notify) plus explicit blocking.

## Consequences

- A row can sit in `pending` indefinitely while presenting as `expired`. Any
  query that surfaces requests must apply the `expires_at` predicate; reading
  `status` alone is wrong. This is the cost of not sweeping and it must be
  respected everywhere, including future admin tooling.
- `money_requests` accumulates without bound. Growth is slow — user-initiated
  and pair-capped — so no retention policy is set now, but this is worth
  revisiting alongside the notifications retention job if volume surprises.
- Phase 8 inherits an exact-amount request primitive. A bill split computes
  each participant's share up front and issues one exact request each, rather
  than issuing one shared request that accepts partial payments.
- Phase 7 owes two follow-on items now recorded in §6: the soft filter for
  requests from non-followed users, and blocking.
