# ADR-0017: A `kyc` module owns tier limits, and limit checks close the race via an advisory lock, not `ledger`'s wallet lock

**Status:** accepted
**Date:** 2026-09-20

## Context

Phase 6 (docs/architecture.md §6) needs three things: a `tier_limits` table
(daily debit limit + balance cap per tier per currency), KYC verification
orchestration (BVN/NIN/liveness calls to an external provider, persisted
verification state), and a limit check that runs inside the same locked
transaction as the money movement it's gating, closing the race where
concurrent requests from one user jointly exceed a limit before either
commits.

No existing module can take this cleanly:

- **`ledger`** can't — it has a zero-peer-dependency property (ADR-0011)
  that a `kyc` import would break, and the limit check needs to know about
  tiers, verification state, and rolling-window sums, none of which are
  accounting concerns.
- **`transfers`**/**`withdrawals`** aren't right either — the limit applies
  identically across both (and funding, in `payments`), so putting it in
  either would mean the other two importing a peripheral-shaped dependency
  from a sibling that's supposed to be about its own orchestration, not
  cross-cutting enforcement.
- **`users`** owns account-level identity/security state (ADR-0005's
  users/auth split, `isFrozen` per ADR-0016), but tier limits are
  transactional/operational data (a `tier_limits` table, a rolling debit
  sum), not account identity — a different shape of thing than what `users`
  currently owns.

This is the same shape of problem ADR-0011 and ADR-0014 each solved: a new
module, justified only if it clears CLAUDE.md's anti-proliferation bar (an
owned table, and a genuinely distinct responsibility) rather than being a
convenience split.

Separately, once the module exists, its limit check has a real mechanical
problem: `ledger`'s posting methods (`postTransferEntries`,
`postWithdrawalEntries`) acquire the ascending-`account_id`
`pessimistic_write` lock on wallet rows *inside* their own private
implementation, then insert entries in the same call. A caller has no seam
to run a check after that lock is acquired but before the insert — and
giving `ledger` a callback parameter invoked at that point would leak a
`kyc`-shaped concern into `ledger`'s signature, undermining the same
zero-dependency property ADR-0011 exists to protect, even as "just a
generic callback."

## Decision

A new `kyc` module owns `tier_limits`, `kyc_verifications`, the
`KycProvider` interface, and the tier-upgrade HTTP surface. It depends on
`users` through its exported service only, to read the current tier and to
call `usersService.setKycTier()` on upgrade — it never writes the tier
column itself, mirroring how `disputes` calls `usersService.freeze()`/
`unfreeze()` rather than reaching into `User` directly (ADR-0016).

`kyc` exposes one method the debit paths (`transfers`, `withdrawals`) call:

```
checkAndReserveLimit(
  manager: EntityManager,
  userId: string,
  amount: Money,
  readDebitedSince: (manager: EntityManager, since: Date) => Promise<Money>,
): Promise<void>
```

The caller passes its own already-open `EntityManager` and calls this before
it calls into `ledger`'s posting methods. `kyc` owns the rule and the lock;
the caller supplies the one ledger fact the rule needs, by wiring
`readDebitedSince` to a new read-only `ledger.getDebitedSince(manager,
userId, since)`. The method:

1. Acquires `pg_advisory_xact_lock(hashtext(userId))` — a transaction-scoped
   advisory lock keyed by user ID, inside the caller's transaction. It is
   the first statement of the check itself; a caller may already hold its own
   row locks before calling (paying a money request locks the request row and
   verifies the PIN first).
2. Computes the start of the current calendar day in `Africa/Lagos` (WAT)
   and calls `readDebitedSince(manager, thatInstant)` — only after the lock
   is held, so the sum can't be read before a concurrent request commits.
3. Compares `debited + amount` against the user's tier's daily limit; throws
   if it would exceed.

What counts as debited is `ledger`'s answer, not `kyc`'s: the principal
`amount` of the user's `p2p_transfer` and `withdrawal` transactions in
`pending` or `completed` status. Fees don't count, and `failed`/`reversed`
transactions don't, so a rejected or reversed withdrawal frees the allowance.

The advisory lock serializes all limit checks for a given user without
`kyc` needing any relationship to `ledger`'s wallet-row lock or its private
posting methods. It auto-releases at transaction end (commit or rollback),
matching the existing "everything happens in one `runInTransaction` call"
convention (`src/database/transaction.util.ts`) already used throughout the
money-moving path.

`ledger` gains exactly one read-only method (`getDebitedSince`) and still no
dependency on any other module. `kyc` gains no dependency on `ledger` and
reads no ledger table.

Funding-initiation's balance cap is a second `kyc` method with the same
shape: `checkBalanceCap(manager, userId, requested, readBalanceAndPending)`.
It takes the same per-user advisory lock, then calls a caller-supplied reader
(backed by a new read-only `ledger` method) that returns the wallet balance
and the total of the user's in-flight `pending` funding transactions, and
rejects when `balance + pending + requested` would exceed the tier's cap. The
lock is needed after all: funding initiation inserts a `pending` row before
the provider is called, and without counting those rows (and serializing the
check with that insert) a user could start several checkouts that each look
fine against a balance that hasn't moved yet, then pay them all and overshoot
the cap through the ordinary in-app flow. The check and the pending-row insert
share one transaction; the provider call stays outside it. A credit that
bypasses initiation entirely (an out-of-band bank credit) is still out of
scope.

Only `pending` fundings created within the last 24 hours count towards the
total (a named constant in `ledger`, not config). Kora documents no expiry for
a hosted checkout and the funding poll leaves a still-pending charge pending,
so an abandoned checkout would otherwise hold cap headroom indefinitely. The
trade-off: a checkout link older than 24 hours that is paid late still
completes through the webhook and can overshoot the cap, the same class as an
out-of-band credit.

**Amended 2026-10-17, before implementation.** The first draft of this ADR
had `kyc` read `transactions` directly by raw SQL, citing `payments`'
reconciliation job as precedent. That precedent does not exist: no module
outside `ledger` reads ledger tables, and reconciliation goes through
`LedgerService`. Raw SQL would also have evaded the module-boundary lint
while coupling `kyc` to ledger's schema.

## Alternatives considered

- **Give `ledger`'s posting methods a hook/callback parameter**, invoked
  after the wallet lock but before the entries insert. Rejected — even as a
  generic `(manager) => Promise<void>` signature with no explicit `kyc`
  import, it exists for exactly one caller's exactly one concern, and a
  reader of `ledger.service.ts` would have to go understand `kyc` to know
  why the hook is there at all. The zero-dependency property is as much
  about `ledger` being *readable in isolation* as it is about import
  statements.
- **Have `kyc` lock the wallet account row itself** (same `SELECT ... FOR
  UPDATE ORDER BY account_id ASC` shape `ledger` uses internally), before
  calling `ledger`'s posting method, which then re-acquires the same lock
  (harmless — Postgres allows re-acquiring a lock already held by the same
  transaction). Rejected — this requires `kyc` to know `accounts`' schema
  and `ledger`'s lock-ordering convention, coupling it to `ledger`'s
  internals through duplicated knowledge instead of through an import,
  which is a worse coupling because nothing enforces the two stay in sync.
- **`kyc` reads `transactions` by raw SQL through the caller's `manager`**
  (the original draft of this ADR). Rejected — it is cross-module table
  coupling the boundary lint cannot see, there is no precedent for it, and
  `transactions` carries `sender_wallet_id`, so `kyc` would also need to know
  how users map to wallets.
- **`kyc` imports `LedgerService`** to read the sum itself. Rejected — it
  adds a `kyc`→`ledger` dependency this ADR set out to avoid, and the
  advisory-lock-before-read ordering would then depend on `kyc` reaching into
  another module mid-check. Passing the reader in keeps `kyc` importing
  `users` only.
- **Fold tier limits into `users`.** Rejected on the same "different shape
  of thing" ground `isFrozen` didn't have to answer — `isFrozen` is a
  boolean flag on account state; `tier_limits` is a seeded reference table
  plus a rolling-window computation, closer to `transfers`'/`withdrawals`'
  shape (owned table, real orchestration) than to a column on `User`.

## Consequences

- Five modules now sit in or beside the money path. ADR-0008's
  disambiguating question gains a further case: tier/limit eligibility →
  `kyc`; everything else unchanged (provider behaviour → `payments`,
  accounting treatment → `ledger`, P2P identity/lifecycle → `transfers`,
  withdrawal destination/orchestration → `withdrawals`).
- `transfers`, `withdrawals`, and `payments` each gain a dependency on
  `kyc`'s exported service, called with their own transaction's manager —
  a new, slightly unusual cross-module call shape (passing an
  `EntityManager` across a module boundary), but one `finalizeTransfer`
  already established internally (`postTransferWithinTransaction(manager,
  ...)`) for the same "compose into an existing open transaction" reason.
- The advisory-lock key is `userId`, not `walletId` or `accountId` — a user
  with multiple currency wallets (Phase 10) would still serialize globally
  across all of them under one lock. Acceptable for now (Phase 6 is
  NGN-only in practice), but worth revisiting once Phase 10 activates a
  second currency and a user can hold concurrent transfers in two
  currencies that don't actually contend for the same limit.
- A new `eslint-plugin-boundaries` entry is needed for `kyc`'s allowed
  imports (`users` only) and for `transfers`/`withdrawals`/`payments`'
  updated allowed imports (adding `kyc`).

## Amendment (2026-10-22): the balance cap also bounds incoming transfers

The cap limits the stored balance, so a P2P credit must respect the
*recipient's* cap as well, for `sendMoney` and money-request payments alike
(both go through `TransfersService.finalizeTransfer`). A new
`kyc.checkTransferLimits(manager, senderId, recipientId, amount, readers)`
runs the sender's daily-limit check (existing behaviour and errors), then the
recipient's cap check using `ledger.getBalanceAndPendingFunding` for the
recipient, which already counts their pending fundings. `kyc` still imports no
ledger code; `transfers` supplies both readers.

**Two user locks, taken in lock-key order.** A transfer now needs the sender's
and the recipient's advisory locks. Taking them sender-then-recipient lets A->B
and B->A each hold one and wait for the other. Both keys are computed with
`hashtext` and locked in ascending numeric key order, once if the keys are
equal. The order is by lock key, not by user id: two different ids can hash to
the same key, and any order defined on the id strings would then disagree with
the order Postgres actually serialises on. Withdrawals and funding remain
single-lock.

**The sender learns nothing about the recipient.** A refusal is
`RECIPIENT_UNABLE_TO_RECEIVE` (422, "This recipient can't receive this amount
right now.") with no details; a tier-0 recipient (cap zero) gets the same
error, so a tier-0 recipient cannot receive any transfer until verified.

**Replays are unaffected:** the idempotent replay check precedes the limit
check, so a completed transfer still returns its original result if the
recipient has since reached their cap.

**Compensating credits are exempt.** `withdrawal_reversal`,
`chargeback_reversal` and the other dispute/reversal postings never call `kyc`,
so a cap can't strand money that is being returned. Funding initiation is
unchanged; funding that completes by webhook after initiation is still outside
the cap, as before.


**Money requests are checked against the requester's cap at creation.**
`kyc.checkCanReceive(manager, userId, amount, readBalanceAndPending)` rejects a
request the requester could not currently receive: `KYC_VERIFICATION_REQUIRED`
for tier 0, `BALANCE_CAP_EXCEEDED` with the cap and remaining headroom
otherwise. It is advisory, so it takes no advisory lock and writes nothing, and
the requester may see their own limits. The payer's error at payment time is
still the generic `RECIPIENT_UNABLE_TO_RECEIVE`.
