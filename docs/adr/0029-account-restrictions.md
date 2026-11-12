# ADR-0029: Account restrictions replace the `isFrozen` boolean

**Status:** accepted
**Date:** 2026-11-09

## Context

`users.isFrozen` is a single boolean with one writer: `disputes` sets it when a
chargeback takes a wallet negative and clears it when the dispute resolves
(ADR-0016). `transfers`, `withdrawals` and `scheduling` read it off an
already-loaded `User`, outside the money transaction, and it blocks outgoing
money only.

Phase 11 adds more reasons to stop an account: a confirmed fraud flag, a
self-lock by the owner, and in 11b a BVN watchlist hit and a sanctions match.
With one boolean and several writers, any writer that clears it clears
everyone's freeze: resolving a dispute would unfreeze an account frozen for
fraud. A sanctions freeze also has to stop money coming *in*, which the boolean
never did.

The check outside the transaction is a race. When an owner locks their account
while an attacker's withdrawal is in flight, the withdrawal can pass a check
that read the state before the lock committed.

## Decision

**A table of restrictions, owned by `users`.** `account_restrictions` has one
row per restriction: `userId`, `reason`, `scope`, `sourceId`, `note`,
`createdAt`, `liftedAt`, `liftedBy`. A partial unique index allows one open row
per `(userId, reason, sourceId)` where `liftedAt IS NULL`. Lifted rows stay as
history.

| reason | scope | added by | lifted by |
|---|---|---|---|
| `dispute` | `outbound` | `disputes` | `disputes`, when the balance is restored |
| `fraud` | `outbound` | `risk` (confirmed flag; two scam reporters) | a reviewer |
| `self_lock` | `outbound` | the owner | the owner, after a password reset (ADR-0034) |
| `watchlist` (11b) | `outbound` | `kyc` | a compliance reviewer |
| `sanctions` (11b) | `all` | `risk` | a compliance reviewer only |

`outbound` blocks P2P sends, paying a money request and withdrawals. `all` also
blocks receiving a transfer and completing a funding.

**No cached flag.** `isFrozen` is dropped. Callers ask
`users.getRestrictionState(manager, userId)` for
`{ blocksOutbound, blocksInbound }`, one indexed read of open rows. A cache
written by five reasons is the drift problem `accounts.balance` is disciplined
against, with nothing to gain here.

**Checked under the lock.** Money paths check restriction state inside their
transaction, after taking the per-user advisory lock they already take for the
KYC limit check (ADR-0017). Adding or lifting a restriction takes the same
lock. A restriction and a money movement for one user are therefore
serialised: either the restriction commits first and the movement is refused,
or the movement commits first and the restriction applies from the next call.

**One writer per row.** Each module lifts only rows it created, by `sourceId`.
A manual lift by a reviewer refuses `dispute` rows (the disputes flow owns
them) and, in 11b, `sanctions` rows outside the compliance flow.

**What the counterparty sees.** A transfer to an account restricted with scope
`all` fails with the same generic "this recipient can't receive payments right
now" a block produces. The reason is never disclosed.

## Alternatives considered

- **More booleans or a reason enum on `User`.** Still one slot per reason with
  no history and no source; two fraud cases on one user collide.
- **Keep `isFrozen` as a cache next to the table.** Two sources of truth for
  every reader to keep straight.
- **Check before the transaction, as today.** Leaves the in-flight withdrawal
  race open, which is the case the self-lock exists for.

## Consequences

- Every `isFrozen` reader moves to `getRestrictionState` inside its
  transaction; `disputes` moves to add/lift by `sourceId`; the disputes
  collections view joins open restrictions.
- Receiving a transfer and completing a funding gain a restriction check, so
  11b's sanctions freeze needs no change to those paths.
- Phase 9's "sender frozen" permanent failure now means `blocksOutbound`.
- Every add and lift writes an audit event (ADR-0030).
