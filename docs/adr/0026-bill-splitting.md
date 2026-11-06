# ADR-0026: Bill splits are peripheral reimbursement over money requests, with status read live and events fanned out per subscriber

**Status:** accepted
**Date:** 2026-11-06

## Context

Phase 8 (docs/architecture.md §6) adds bill splitting: a user splits a bill
with several people, each participant gets a payment request, the initiator
tracks who has paid, the split closes when everyone has paid, and uncompleted
splits expire.

ADR-0012 already planned for this. A money request is exact-amount only so
that a split can compute every share up front and send one exact request per
participant, instead of one shared request that accepts partial payments.
ADR-0025 settled that split requests may go to people who don't follow the
initiator: they land in the payer's "others" bucket, and blocks still apply.

What was still open:

- **Where the money goes.** Either participants pay the initiator back for a
  bill already paid, or they pay into a pool released when the split
  completes.
- **Where paid/unpaid lives.** Each share's payment state already exists,
  correct and transactional, as its money request's `status`.
  `payRequest` writes it in the same transaction that posts the transfer. A
  split could copy that state into its own tables, or read it.
- **How billsplit hears about payments.** The event bus publishes every event
  to one BullMQ queue, `domain-events`, consumed only by notifications.
  BullMQ queues share work out between workers instead of broadcasting, so a
  second `@Processor` on that queue would take about half of every event,
  notifications included. Publishing also has no transactional outbox: an
  event is lost for good if the process dies between the commit and
  `queue.add`, and `payRequest` doesn't republish on an idempotent replay.
- **An existing race.** `cancelRequest` and `declineRequest` read the request
  without a lock and then save the new status. A payment that commits between
  the read and the save is overwritten: the money moved, the request says
  `declined` or `cancelled`, and `transactionId` is still set. Splits would
  read that wrong status live.

## Decision

**Reimbursement, not escrow.** The initiator has already paid the bill.
Participants pay the initiator back through ordinary money requests, so each
payment is a `p2p_transfer` with every existing transfer rule. No ledger
account, posting rule or invariant changes. The `bill_split` value in the
`transactions.type` CHECK stays reserved and unused. Changing that CHECK
needs a hand-written migration for no gain.

**`billsplit` is peripheral.** If it disappeared, every split request would
still be payable and money would still move correctly. It owns `bill_splits`
and `bill_split_participants`. It depends on `transfers` and `users` through
their exported services, and `transfers` never learns that splits exist: no
column on `money_requests`, no call back into `billsplit`.

**Paid/unpaid is read live, never copied.** Each participant row stores its
`money_request_id` (cross-module, no FK, unique). A split view loads its
participant rows and makes one batched read of their requests through
`TransfersService`. The split's status is derived in this order:

| status | when |
|---|---|
| `cancelled` | `cancelled_at` is set |
| `completed` | every request is paid |
| `closed` | no request is pending, and at least one was declined or cancelled |
| `expired` | `now > expires_at` and some request is unpaid |
| `open` | otherwise |

`completed_at` and `closed_at` are recorded on `bill_splits` so lists can be
filtered on billsplit's own table. They are written by the event handler and
repaired on read: a read that derives `completed` or `closed` with the
timestamp still null sets it. Lists filter by these stored timestamps; a
filter on a single participant's status ("splits where Tunde hasn't paid") is
not offered, because it would need a join into another module's table.

**Shares.** Two modes, fixed at creation. `equal`: the server divides the
total. `custom`: the client sends each participant's amount and the server
checks they don't exceed the total. The initiator always has a share, which is
counted but never requested: in `equal` mode it takes any leftover kobo, and
in `custom` mode it is the total minus the requested amounts, zero allowed.
The division goes through a new `Money.allocate`. Every requested share must
be at least `TRANSFER_MIN_AMOUNT`.

**Money-request rules apply unchanged.** Split requests count toward the
3-pending-per-pair cap. A participant at the cap, a blocked participant, or
the initiator listed as a participant fails the whole split, with the error
naming the participant where that doesn't reveal a block. The split computes
one `expires_at` from `MONEY_REQUEST_EXPIRY_DAYS` and passes that exact value
to every one of its requests, so the split and its requests can never expire
at different moments. Expiry is derived on read, with no sweeper.

**Declines and cancels.** A decline ends only that participant's share; the
others can still pay. The initiator cancelling the split sets `cancelled_at`
and cancels every still-pending request in one transaction, locking the
request rows in id order. Paid shares stay paid. Cancelling a single split
request through the existing money-request endpoint is allowed and counts
like a decline.

**The cancel/decline race is fixed.** `cancelRequest`, `declineRequest` and
the split's bulk cancel lock the request row (`pessimistic_write`) and
re-check that it is still pending before writing, the same way `payRequest`
does. Whichever of pay and cancel commits first wins; the other sees a
non-pending request.

**Creation is atomic and idempotent.** The split and all its requests are
written in one transaction. Pair locks are taken in ascending participant user
id order, so two concurrent splits from one initiator can't deadlock.
Creation requires a client `reference`, unique per initiator: a replay with
the same contents returns the original split, a replay with different
contents is a 409, as for transfers (ADR-0010). The `money_request_created`
events are published after commit.

**Limits.** 1 to `BILL_SPLIT_MAX_PARTICIPANTS` (20) distinct participants,
excluding the initiator. A required description of 1 to 140 characters
becomes each request's `note`, so the payer sees what the request is for. The
initiator's KYC receive check runs once against the sum of the requested
shares. It is advisory, as for requests: the limit is enforced again on every
payment. No extra tier gate; NGN only.

**Visibility.** The initiator and every participant see the whole split: the
description, the total, and each participant's share and status. Anyone else
gets 404. A block created after the split doesn't remove anyone from it.

**Notifications.** Participants get the existing `money_request_created`.
The initiator gets the existing `money_request_paid` and
`money_request_declined`, which already covers "notified as each person
pays". One new event, `bill_split_completed`, goes to the initiator by push
and in-app (not email, since each payment already emailed them), deduped on
the split id so the event handler and read-repair can't both send it. Cancel,
`closed` and expiry send nothing.

**The event bus fans out per subscriber.** A subscribing module declares its
own queue and the event names it wants. `EventBusService.publish` adds the
event to `domain-events` as before, and to every queue subscribed to that
name. Each subscriber retries on its own, so a billsplit failure never
re-sends a notification. `billsplit` subscribes to `money_request_paid`,
`money_request_declined` and a new `money_request_cancelled`, which has no
notification catalog entry and exists only so `closed_at` lands promptly.

## Alternatives considered

- **A pooled escrow account.** Rejected. It needs a new account type, posting
  rules, invariant coverage and a refund path on expiry, and nothing in the
  phase pays a third party from the pool or needs to keep partial collections
  from the initiator.
- **Splits inside `transfers`.** A `bill_split_id` on `money_requests` would
  let `payRequest` close a split atomically, but it puts split logic in a core
  module on the money path, the same overload ADR-0005 had to undo.
- **Copying paid/unpaid into billsplit through events.** Duplicate and
  out-of-order delivery would be harmless, because the transitions are
  idempotent and terminal. A lost event is not: with no outbox, the split
  would show a paid share as unpaid for good, and the initiator would chase
  someone who already paid. Making the copy safe needs an outbox or a
  reconciliation sweep, which is a cross-cutting infrastructure decision, not
  a Phase 8 one.
- **Exempting split requests from the pair cap.** Rejected: one-person splits
  would bypass the cap entirely.
- **Skipping participants at the cap.** Rejected: the shares would no longer
  add up to the total.
- **A separate `BILL_SPLIT_EXPIRY_DAYS`.** No case was found where a split
  should live longer or shorter than a request.
- **Failing the whole split, or redistributing the share, on a decline.**
  Failing punishes the people who meant to pay and can't undo paid shares.
  Redistributing means cancelling and re-issuing exact-amount requests.
- **Blocking per-request cancel of a split request.** It would need
  `transfers` to know about splits, a core module depending on a peripheral
  one.
- **No creation `reference`.** A double tap would send every participant two
  requests and use two of their three pair-cap slots.
- **Read-repair only, no event consumer.** `bill_split_completed` would fire
  only when someone happened to open the split.
- **Redis Streams with consumer groups for domain events.** Real pub/sub, but
  it rewrites the bus, the notification processor's retries and their tests,
  where publish-side fan-out is a small change to the existing bus.

## Consequences

- A split's displayed status is always correct, because it is read live. The
  stored `completed_at`/`closed_at` can lag the last payment by the event
  delay, or longer if the event was lost, until the next read repairs it.
- `TransfersService` gains manager-accepting methods for creating a split's
  requests, reading requests by id, and cancelling a set of requests.
- A lost `money_request_paid` still loses a notification, as for every other
  notification. A transactional outbox would fix that everywhere and is worth
  its own ADR later.
- The event bus can now have several subscribers. Phase 9 scheduling is the
  next likely one.
