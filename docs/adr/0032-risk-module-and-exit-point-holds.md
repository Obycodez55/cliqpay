# ADR-0032: A core `risk` module detects anywhere and holds money at withdrawal

**Status:** accepted
**Date:** 2026-11-09

## Context

Phase 11 moves from static limits to fraud detection: velocity rules,
large-amount-on-a-new-account, the mule pattern, human review, holds. The
CBN's APP-fraud draft asks for an Early Warning System with documented
indicators, red-flagged accounts restricted pending investigation, and
liability for an institution that fails to flag or freeze proceeds. Phase 11b
adds AML monitoring on the same machinery.

P2P is internal: money that stays in Cliqpay can still be held or returned. A
withdrawal to a bank is irreversible. Blocking P2P on a rule hit punishes
legitimate users for false positives on the most common action in the app.

A withdrawal already posts its ledger entries (status `pending`) before Kora
is called, and a rejected payout runs `reverseWithdrawal`.

## Decision

**Detect anywhere, hold at the exit.** An open, enforced flag holds the
flagged user's withdrawals and nothing else. P2P sends, receiving and funding
continue. Only a confirmed flag adds a `fraud` restriction (ADR-0029), which
also blocks outgoing P2P.

**A `risk` module, core by §10.** Withdrawals call it synchronously before
committing. It owns `fraud_flags`, `fraud_rules`, and (from 11b) screening,
risk ratings and AML reports. Its service exposes
`evaluateWithdrawal(manager, …)` and event subscribers for after-commit rules.

**`fraud_flags`.** `id`, `userId`, `kind` (`fraud` | `aml`), `ruleCode`,
`transactionId` (nullable), `evidence` (jsonb), `hitCount`, `status`
(`open` → `reviewing` → `cleared` | `confirmed`), `enforced`, `reviewedBy`,
`reviewedAt`, `reviewNote`. One open flag per `(userId, ruleCode)` by partial
unique index; a repeat hit appends evidence and increments `hitCount`.
`enforced` is fixed at creation: a shadow flag holds nothing and is listed
separately.

**`fraud_rules`.** One row per rule with `mode` (`off` | `shadow` |
`enforce`) and `params` (jsonb), seeded by migration like `tier_limits`. Rule
logic is code; only mode and thresholds are data. Changed by hand-written
migration until the admin panel can edit them (audited).

**11a rules.**

| rule | when | trips | starts |
|---|---|---|---|
| `mule_fan_in` | withdrawal | ≥5 distinct P2P senders in 24h and the withdrawal ≥50% of those inflows | enforce |
| `new_account_large_withdrawal` | withdrawal | account <7 days old, withdrawal ≥₦100,000 | enforce |
| `tainted_inflow` | withdrawal | ≥₦5,000 received in 72h from a user with an enforced open flag or an active `fraud` restriction | enforce |
| `send_burst` | after commit | ≥10 P2P sends in 10 min, or ≥5 first-time recipients in 1h | shadow |
| `shared_device` | after commit | ≥3 distinct users bound to one `deviceId` in 30 days | shadow |
| `device_integrity` | device registration | attestation failed (ADR-0031) | shadow |

`tainted_inflow` follows money one hop: a mule who forwards to an accomplice
has the accomplice's withdrawal held, without holding every P2P send.

**Withdrawals under review.** When `evaluateWithdrawal` finds an enforced open
flag, or a withdrawal-time rule trips in enforce mode, the withdrawal posts as
usual but with the new status `under_review`, and Kora is not called.
`transactions.status` gains `under_review`. A reviewer releases it (Kora is
called; it continues as `pending`) or rejects it (`reverseWithdrawal`, as for
a rejected payout). The withdrawal poll only reads `pending`, so it never asks
Kora about an unsent payout. A scheduled bank run whose withdrawal is under
review stays `settling` (ADR-0028). Clearing a flag does not release its held
withdrawals; each gets its own decision.

**What the user sees.** "This withdrawal is being reviewed. This usually takes
up to 24 hours." Identical for every cause.

**No automatic resolution.** A review past its target alerts ops; nothing
releases or rejects on a timer, or waiting out a review becomes a way out.

**Interim review endpoints** under `/internal/risk/*`, guarded per ADR-0030:
list and read flags (shadow separately), review a flag, release or reject a
held withdrawal, lift a restriction (refusing `dispute` and, later,
`sanctions`), and recover a self-locked account's email (ADR-0034). Every
write is audited.

## Alternatives considered

- **Synchronous rules on every P2P send.** Latency on the hot path and false
  positives on the commonest action, for money that is still recoverable.
- **Holding the whole account on an open flag.** One false positive would
  lock out a legitimate user over one transfer.
- **Rule settings in env.** Moving a rule from shadow to enforce would need a
  redeploy; easy tuning is the point of modes.
- **A separate AML module.** The same engine, flags and review loop with a
  different `kind`.
- **Auto-release after a deadline.** Turns review into a waiting game.

## Consequences

- `risk` is core; `withdrawals` depends on it, and `boundaries` lint gains the
  element.
- `transactions.status` gains `under_review`, which history and the limit
  sums must treat like `pending` (money reserved, not settled).
- Rules start conservative and are tuned through migrations until the admin
  panel exists.
- Phase 11b adds `kind = 'aml'` rules, screening and risk ratings to this
  module rather than a new one.

## Decisions made building the risk module

- **`evaluateWithdrawal` writes flags in the withdrawal's own transaction.** A
  hit made by a withdrawal that then fails (say, insufficient funds) rolls back
  with it. The withdrawal's id does not exist yet when rules run, so flags are
  created with a null `transactionId` and `linkWithdrawal` fills it in after
  the ledger posts. A repeat hit keeps the first withdrawal's id.
- **`enforced` stays as created, but the hold follows the rule's current
  mode.** If a rule is switched from shadow to enforce while a shadow flag is
  open, the next trip still holds that withdrawal, and the flag stays shadow
  with a higher `hitCount`. The flag is never promoted; once it is resolved,
  the next hit opens a new, enforced one.
- **Open means `open` or `reviewing`.** The partial unique index and the hold
  check use the same pair. A flag moves `open → reviewing`, or either to
  `cleared` / `confirmed`; a resolved flag cannot move again.
- **Withdrawal-time rules only write when their mode is not `off`.** A rule in
  `shadow` raises a shadow flag and holds nothing; `off` is skipped entirely.
- **`tainted_inflow` and `mule_fan_in` read one query.** `LedgerService`
  returns P2P inflow per sending user for a window; the rule logic is pure
  functions over it in `risk/internal/rules.ts`. Tainted senders are users
  with an open enforced flag or an open `fraud` restriction. Shadow flags and
  cleared flags do not taint.
- **Event-driven rules run from two events.** `transfer_sent` feeds
  `send_burst`. A new `device_registered` event, published by `auth` after the
  trusted-device transaction commits, feeds `shared_device` and
  `device_integrity`, so `auth` never imports `risk`. `shared_device` asks
  `AuthService` how many distinct users were bound to the device in the
  window, and flags the user who just registered.
- **Release and reject live in `withdrawals`.** They need the payout code, and
  `withdrawals` depends on `risk`, so they are served under
  `/internal/risk/withdrawals/*` by a controller in `withdrawals`. Release
  flips `under_review → pending` with one guarded UPDATE and then calls Kora
  as at initiation; a synchronous rejection reverses the withdrawal. Reject
  reverses only from `under_review`, so a reviewer cannot reverse a payout
  that was already sent. Both publish the usual withdrawal events so a
  scheduled run settles; the failed event carries a generic reason.
- **Reconciliation adds held withdrawals to the expected provider balance.** A
  held withdrawal has debited float but Kora has not paid it, so the provider
  still holds `amount + providerFee` for it.
- **Overdue alert.** A job every 6 hours sends one digest email to the
  reconciliation alert address when an enforced flag or a held withdrawal is
  past 24 hours. It repeats every run until the backlog is cleared and keeps no
  alert state. Shadow flags are observation only and are not chased. Nothing
  is resolved by the job.
- **Rule params live in `fraud_rules.params`.** Money thresholds are minor
  units (`minAmountMinor`); the migration seeds the starting values from the
  table above.
- **Lifting a restriction** refuses `dispute` and `sanctions`; every other
  reason can be lifted through `/internal/risk/restrictions/lift`. The
  existing `restriction_lifted` audit event records the reviewer.
