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
