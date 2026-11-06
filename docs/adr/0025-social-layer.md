# ADR-0025: `social` is a core module that owns the social graph, and a transfer's post is stored in the transfer's own transaction

**Status:** accepted
**Date:** 2026-11-05

## Context

Phase 7 (docs/architecture.md §6) adds transaction notes, per-transaction
visibility, follows, an activity feed, reactions, comments, blocking, and a
soft filter on money requests from users the payer doesn't follow.

Three things about it don't fit the shape earlier phases established:

- **A core module needs the social graph synchronously.** Blocking must
  reject a money request (and, per the decision below, a transfer) at
  creation, and the soft filter must know at creation whether the payer
  follows the requester, because that decides how the request notifies.
  `transfers` is core (ADR-0011) and may not import a peripheral module. §10
  listed `social` as peripheral, but only as an enumerated list from v1 —
  there was no written criterion for what makes a module core or peripheral,
  and each later module was placed by analogy.
- **Part of a transfer request's own data has no home in `ledger`.** The
  sender sends `visibility` with the transfer. It is mutable afterwards (the
  sender can change it; the recipient can hide the post), so it can't live
  in `transactions`, which `ledger` owns and which nothing outside `ledger`
  writes. The only post-commit path out of `transfers` is the event bus, and
  `publishTransferEvents` logs and drops a failed publish without retrying.
  That is acceptable for a notification; it is not acceptable for the user's
  explicit choice about who can see their payment.
- **Privacy is the central product risk, not a detail.** A public record of
  who pays whom, and how often, is a targeting signal for scams and
  profiling. Venmo's public-by-default feed is the cautionary example.

## Decision

**The core/peripheral criterion.** A module is core if money would stop
moving correctly or safely without it: it is on the money path, or a
money-moving operation must consult it synchronously before committing. A
module is peripheral if it only reacts to money movement after commit and
could be removed or extracted without the money path noticing. §10 records
this criterion; new modules are placed by it, not by analogy.

**`social` is core.** Blocking gates money requests and transfers
synchronously, so `social` fails the removability test. It owns `follows`,
`blocks`, `transaction_posts`, `post_reactions` and `post_comments`.
`transfers` imports `SocialService` directly, as it already does
`KycService`. `social` depends on `users` (tier, display names) and never on
`transfers`, `withdrawals`, `disputes` or any peripheral module. It learns
about transfers only through the post row written below and through events.
It gets its own lint element type and leaves the `peripheral-module`
pattern.

**A transfer's post is written inside the transfer's transaction.**
`TransfersService` calls `socialService.recordTransferPost(manager, …)`
with the transaction id, both participants, the note and the visibility,
inside the same transaction that posts the ledger entries. This is the
pattern `kyc` → `users.setKycTier(manager, …)` already uses. The post
exists if and only if the transfer committed. §10's "cross-module side
effects are async events" rule still governs *reactions* to a commit
(notifications, feed-adjacent work, fraud rules). Storing part of the
request's own data in the core module that owns it is not a reaction.

**Notes live on the transaction; `social` keeps a snapshot.** The note is
part of the payment record: it appears in both parties' history whether or
not the transfer is public, it belongs in a dispute or fraud review, and it
rides on the transfer's notification. It goes in `transactions.metadata`.
Notes are immutable as a product rule: someone must never be able to
rewrite "loan" as "gift" after the money has moved. Immutability is what
makes the copy on `transaction_posts` safe, and that copy lets the feed be
served from `social`'s own tables without a hop into `ledger` per page.

**Visibility is explicit, two-flagged, and never shows the amount.**

- `visibility` (`public | private`) is required on every transfer request.
  The server never applies a default. A per-user default stored for clients
  to prefill is future work, not this phase.
- `note` and `visibility` are part of the idempotency fingerprint
  (ADR-0010). A replay with either changed is a 409, not a silent replay.
- The sender's `visibility` and the recipient's `hidden_by_recipient` are
  independent. A post is public only while `visibility = public AND NOT
  hidden_by_recipient`. Neither party can override the other's objection.
- The feed never shows an amount, whatever the visibility.
- A public post is seen by followers of either participant and by the
  participants themselves. There is no per-user public timeline.

**Blocking is the full set of interactions.** Whichever side blocks:
neither can create money requests to the other, send money to the other,
follow the other (existing follows are removed), see posts involving the
other in their feed, or react or comment on posts the other participates in.
When a participant blocks someone, that user's existing comments and
reactions on the participant's posts are hidden from every reader and left
out of the counts. Existing pending requests from the blocked user are hidden
at read time, not cancelled. Recipient lookup is unchanged. Rejections never
name the block: transfers and money requests reuse `RECIPIENT_UNABLE_TO_RECEIVE`,
and follows, reactions and comments return `INTERACTION_UNAVAILABLE`. A
blocked user may still infer the block. Full concealment isn't attempted,
because lookup still resolving the blocker and the transfer rejection
already signal it. Blocking is ungated by KYC tier.

**Social participation requires KYC Tier 1.** Following, reacting,
commenting and every social read surface reject Tier 0 with
`KYC_VERIFICATION_REQUIRED`. Tier 1 requires a BVN or NIN that is unique
across accounts, so a block sticks to a person rather than an email address.
Identity data (the provider-returned legal name) and tier never appear on a
social surface.

## Alternatives considered

- **Keep `social` peripheral; put follows and blocks in `users`.** `transfers`
  already imports `users`. Rejected: follows and blocks are relationships
  between users, a social concern, and `users` is identity and account
  state.
- **Keep `social` peripheral behind a port.** An interface and DI token in
  `src/shared`, implemented by `social` through a `@Global()` provider.
  Rejected: with no fallback implementation, the app fails to boot without
  `social`, so it isn't removable anyway — the port preserves the label
  "peripheral" without the property the label exists for. A fallback of
  "nobody is blocked" is a dangerous default for a safety check.
- **A local projection of the graph in `transfers`, fed by events.**
  Rejected: a duplicated graph with a lag window. Block someone, and their
  request sent a second later can slip through.
- **Create the post from the post-commit transfer event.** Rejected: a lost
  publish silently drops the user's explicit visibility choice, and the
  transfer can then never be toggled, reacted to or commented on.
- **Store visibility in `transactions.metadata` with the note.** Rejected:
  visibility is mutable, so `social` would be writing ledger's rows.
- **Store the note only in `social`.** Rejected: private transfers would lose
  their note from history, or `social` would become a second copy of payment
  history that wallet history has to join out to.
- **Public by default (Venmo).** Rejected on the privacy risk above. Private
  by default is also rejected in favour of no server default at all.
- **One shared visibility field either party can set.** Rejected: last write
  wins, so the sender could re-publish over the recipient's objection.
- **Block requests and social interactions only, leaving transfers open.**
  Rejected: with notes on every transfer, a ₦1 transfer is a message, and
  "₦1: [abuse]" is a known harassment pattern on payment apps.
- **Gate only comments on Tier 1.** Rejected: a Tier 0 follower could still
  read the public feeds of whoever they follow, which is the graph-scraping
  surface the owner-only follower lists exist to close.

## Consequences

- `transfers` gains `socialService.isBlocked` checks on transfer and
  money-request creation, and a `follows` lookup on money-request creation.
  The transfer check is one pair advisory lock, shared with `block`, plus one
  indexed lookup on the hottest write path.
- The transfer transaction gains one insert. It takes no locks beyond its own
  row, so it doesn't widen the wallet lock window.
- Making `visibility` required on `SendTransferDto` and the pay-money-request
  DTO breaks existing callers and fixtures. Nothing is launched, so this is
  accepted.
- `transaction_posts` holds a row for every transfer, private included,
  because a private post can be made public later. Transfers made before
  Phase 7 have no row and never become posts; there is no backfill.
- The feed is fan-out on read, bounded by a 5,000 follow cap. If it gets
  slow at real volume, fan-out on write becomes a measured decision.
- `notifications` (peripheral) imports `SocialService` to check blocks at
  dispatch time, the allowed direction.
- Any future case of a core module needing a capability currently treated as
  peripheral is decided by the removability criterion, not by adding a port
  to keep the label.
