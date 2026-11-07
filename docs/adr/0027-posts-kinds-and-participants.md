# ADR-0027: Posts are generalised to kinds and participants, keyed by their subject's id

**Status:** accepted
**Date:** 2026-11-07

## Context

ADR-0025 built posts for one case: a completed P2P transfer between exactly two people. `transaction_posts` has a sender, a recipient and the recipient's `hidden_by_recipient` veto. The feed reads two partial indexes, one on each of those columns. Every rule is written for two parties:
- who can read a post;
- who may react or comment;
- whose block hides whose content;
- who is notified.

Phase 8 adds bill splits (ADR-0026). A split is a group activity between an initiator and up to 20 participants. Each share is paid as an ordinary money request, so each share is its own P2P transfer. Under ADR-0025, a six-person dinner produces five separate "X paid A" posts, and nothing represents the split itself. Esusu (§11) has the same shape: one round, many contributions.

The consent model from ADR-0025 still applies:
- nothing reaches a feed unless the acting user chose its visibility explicitly;
- everyone else named in a post can veto it;
- amounts never appear.

## Decision

**One `posts` table, with participants.** `transaction_posts` is replaced by:

- `posts`:
  - `id`;
  - `kind`: `transfer` or `bill_split`, CHECK-constrained;
  - `author_user_id`;
  - `note`: a snapshot;
  - `visibility`: the author's choice;
  - `requested_visibility`: as sent on the creating request, never updated;
  - `origin`: nullable, for example `money_request`;
  - `published_at`: nullable;
  - `is_public`;
  - `created_at`, `updated_at`.
- `post_participants`:
  - `(post_id, user_id)` primary key;
  - `role`: `author`, `counterparty` or `member`;
  - `hidden`: boolean;
  - `post_created_at` and `post_is_public`, copied from the post so the feed can read one index.

A transfer post has its sender as `author` and its recipient as `counterparty`. A split post has its initiator as `author` and every participant as `member`.

**A post's id is its subject's id.**
- A transfer post's id is the transaction id. A split post's id is the split id. A future kind's post id is its own subject row's uuid.
- This keeps every existing `/social/posts/:id` route working. It also keeps the `transactionId` that transfer, money-request and wallet-history responses already return working as a post id, without `wallet` or `ledger` ever importing `social`.
- Invariant: **at most one post per subject id, across all kinds.** The primary key enforces it.
- `posts.id` is therefore not generated. It is the one exception to the generated-uuid primary key rule, and `entity-columns.spec.ts` lists it with that reason.
- `kind` stays on the row so a route can reject an id of the wrong kind.

**Effective publicity is stored, and recomputed in one place.**
- `is_public = published_at IS NOT NULL AND visibility = 'public' AND no participant has hidden = true`.
- Every write that changes any of those inputs takes the same steps through one function:
  1. lock the `posts` row `FOR UPDATE`;
  2. recompute `is_public`;
  3. write it to `posts.is_public` and to every `post_participants.post_is_public` row for that post, in the same transaction.
- The writes that change those inputs are: the author's visibility toggle, a participant's hide or unhide, and publication.
- This is the same "one computation, one place, same transaction" discipline as the cached balance. A toggle and a hide racing each other cannot leave a stale value.

**Vetoes are a rule, not a per-role switch.** Every participant except the author can hide and unhide. Only the author can change `visibility`. A new kind inherits this without code changes.

**Publication.**
- A transfer post is published when it's created, inside the transfer's transaction, as today.
- A split post is created unpublished in the split's creation transaction. It is published only when the split completes. `billsplit` calls `socialService.publishPost(manager, splitId)` inside the transaction that records `completed_at`, from both its event handler and its read-repair path.
- `publishPost` is idempotent: it sets `published_at` only if it is null.
- A split that closes, expires or is cancelled never publishes.
- If the completion event is lost and nobody reads the split again, the post stays unpublished. That fails closed, which is the safe direction for publication.
- Participants can read, react to and comment on an unpublished split post. It's visible only to them either way, every block rule applies, and its notifications go to the author only.
- Lock order on completion: `billsplit` locks its `bill_splits` row, then `publishPost` locks the `posts` row. Nothing in `social` ever locks `bill_splits`, so there's no cycle.

**`createPost` contract.** `createPost(manager, …)` inserts a post and its participant rows and computes publicity. It takes no pair locks and runs no block checks between participants. A caller that has to gate on blocks does so itself, before calling: transfers through `lockPairAndCheckBlock`, splits through request creation. That keeps member↔member blocks allowed in a split.

**Group payments don't post individually.**
- Money requests gain a core-owned `kind`: `direct` or `group_share`. It describes the request, not the split.
- Paying a `group_share` request records no post.
- Its payment forbids `visibility`: sending it is a 400. A `direct` payment still requires it.
- Its idempotency check compares the note only.
- As a result, not every P2P transaction id has a post. The response documentation says so.

**Rules generalised from two parties to N.**
- **Reading:** a participant can always read their own post, published or not. For transfers this is exactly today's rule, with "either participant" generalised to "any participant". Anyone else can read it only if:
  - it is public;
  - they follow at least one participant;
  - there is no block either way between them and any participant.
- **Feed:**
  - one LATERAL per followed user reads the partial index on `post_participants (user_id, post_created_at DESC, post_id DESC) WHERE post_is_public`, bounded by the cursor and LIMIT;
  - the branches are deduplicated by post before the final ORDER BY and LIMIT, because a post reaches the viewer once through each followed participant;
  - pagination is keyset on `(created_at, id)`, compared as text, as before.
- **Interacting:**
  - reacting or commenting takes `lockPair` with every other participant, in sorted user id order, and then reads the post again;
  - on a transfer post, a block with the other participant is `INTERACTION_UNAVAILABLE`;
  - on a split post, only a block (in either direction) between the actor and the post's author is `INTERACTION_UNAVAILABLE`; blocks between two members refuse nothing;
  - every pair is still locked, because a non-participant's read of a public post depends on their blocks with all participants, and at most 20 locks are taken.
- **Hidden content:**
  - on a transfer post, or when the blocker is a split's author, a block by the viewer or by any participant hides the blocked user's comments and reactions on that post from everyone;
  - on a split post, a block by a member hides the blocked user's content only from that member, and each viewer's own blocks hide content from them, so the initiator and other members see both sides.
- **Blocks between members:** members who have blocked each other may share a split. Rejecting them would tell the initiator, a third party, about a block between two other people. On the post, both can still comment and react, and each one's content is hidden only from the other (a one-way block hides the blocked member's content only from the blocker). Everyone else, including the initiator, sees both, so the initiator learns nothing about the block.

**Notifications by kind.**
- Transfer posts are unchanged: comments go to the other participant by push and in-app, and reactions in-app.
- Split posts notify the author only. Comments go by push and in-app, and reactions in-app. Members aren't subscribed, which keeps a 21-person post from pushing 20 people on every comment.
- Everything is still block-checked when it is sent.

**What a participant sees.**
- The post view shows a participant `visibility`, whether the post is published, whether it's public, and their own `hidden` flag.
- It never shows which participant hid it.
- Feed items carry `kind`, `author`, `participants[]` (identity and role), `note`, `createdAt`, the reaction and comment counts, and `origin`. They never carry an amount.

## Alternatives considered

- **A separate post id, `UNIQUE(kind, subject_id)` and a lookup route.** Wallet history could never carry a post id, because `wallet` can't import `social`. Every client would need an extra lookup hop.
- **Keep `transaction_posts` for transfers and add a second table per kind.** Every rule above (reading, feed, interaction, hidden content, notification) would be written once per kind, and the feed would grow one UNION branch per kind.
- **Post every share payment.** That floods the feed with N "X paid A" posts per split and loses the split as one thing.
- **Publish a split post when it's created.** Participants haven't acted yet. A pending split would publicly say who owes the initiator, which is the shaming risk issue #88 rules out for pending requests.
- **Compute `is_public` at read time, not store it.** The feed's partial index can't refer to another table's rows. Without the copied flag, the per-user branch scans private and hidden rows with no bound.
- **Notify every member on a split post.** At 21 participants, every comment pushes 20 people.
- **Name the split in `money_requests` (`bill_split_id`).** Rejected in ADR-0026. `kind = group_share` tells `transfers` how to treat the payment without referring to `billsplit`.

## Consequences

- Breaking changes to the feed and post response shapes (`sender`/`recipient` become `author`/`participants[]`). Nothing has launched, so this is accepted.
- **Built incrementally.** The model above is the target. Each column and CHECK value arrives with the slice that first needs it:
  - **Phase 8 slice 2** (no behaviour change): `posts` and `post_participants` with `kind` limited to `transfer` and `role` limited to `author` and `counterparty`. `is_public` means public and not hidden. No `published_at`, no `origin`, no `publishPost`.
  - **Slice 3:** `origin`, set to `money_request` on a post from paying a `direct` request, together with `money_requests.kind`.
  - **Slice 6:** `published_at`, backfilled to `created_at` for existing transfer posts. The `bill_split` kind and `member` role are added by hand-written CHECK migrations alongside the entity edits, because the drift check can't see CHECK value changes. `publishPost` arrives here, and the `published_at` term joins the publicity computation.
- **Migration:** a hand-written backfill moves every `transaction_posts` row into `posts`, using the transaction id as its id, plus two participant rows. It then repoints `post_reactions.post_id` and `post_comments.post_id` from the old row id to the transaction id, moves their foreign keys to `posts`, and drops `transaction_posts`. Its `down` restores the data as well as the schema.
  - Notification rows already key on the transaction id, so they don't move.
  - Feed cursors carry the post id, which changes meaning. Cursors are ephemeral and there are no clients yet, so stale cursors are acceptable.
- Adding a kind is a hand-written migration that extends the `kind` CHECK, plus the subject's creation and publication calls. No reading, feed or interaction code changes.
- A toggle or hide writes up to 21 participant rows. The cost is bounded by the participant limit.
- ADR-0025's statements that "every transfer has a post" and that the recipient has a veto still hold for direct transfers. Group-share payments are the stated exception.
- `billsplit` (peripheral) depends on `social` (core) for `createPost` and `publishPost`. That's allowed, and the lint rule messages that list who depends on `social` gain `billsplit`.
