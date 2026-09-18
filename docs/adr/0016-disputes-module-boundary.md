# ADR-0016: A `disputes` module owns chargeback ingestion and dispute lifecycle

**Status:** accepted
**Date:** 2026-09-18

## Context

Phase 5's architecture.md bullet assumed "provider chargeback/dispute webhook
handling" — the same shape as funding and payout webhooks, which would have
pointed at `payments`. Checking Kora's actual webhook documentation during
design surfaced that this assumption doesn't hold: Kora's webhook system
supports exactly three event families — `charge.success/failed`,
`transfer.success/failed`, `refund.success/failed` — and models no
chargeback or dispute event at all. (Paystack does, via
`charge.dispute.create/remind/resolve` — but adding Paystack as a second
provider solely to get this is out of scope for this phase; see #33.)

In the real world this shows up as a chargeback notice from Kora reaching
Cliqpay's ops team out-of-band (settlement statement, merchant dashboard,
email) — not as a webhook. There is no provider payload to verify or parse,
which means this was never actually a `payments` concern once the design
caught up with the fact: ADR-0008's own test (would this change if Kora
changed its API? No. Would it change if the accounting treatment changed?
Yes, partially) points away from `payments` on the ingestion side.

But it isn't pure `ledger` work either. Recording a chargeback needs to:
verify a transaction PIN or comparable trust boundary is unnecessary here
(admin-triggered, not user-initiated), but it does need to post a
compensating transaction (`ledger`), freeze the account when balance goes
negative (`users`), and notify the user (`notifications`, peripheral, via
domain event). `ledger` has a hard zero-peer-dependency invariant (ADR-0011)
that importing `users` would break — the same shape of problem ADR-0011 and
ADR-0014 already solved for `transfers` and `withdrawals`.

Dispute *resolution* (upheld / resolved-in-Cliqpay's-favor) is a further
orchestration: it can post a second compensating transaction, flip the
original funding transaction's status, and lift the freeze — none of which
belongs inside `ledger`'s zero-dependency accounting layer either.

CLAUDE.md's anti-proliferation rule applies the same way it did for
`transfers`/`withdrawals`: a new module is only justified by a genuinely
distinct responsibility, not a convenience split.

## Decision

A new `disputes` module owns:

- The `disputes` table (chargeback-reference, status, resolution state —
  see docs/architecture.md §5).
- The admin-triggered chargeback-recording endpoint and dispute-resolution
  endpoint, gated by a new shared-secret internal guard (no `AdminUser`
  model exists yet — §9 of the architecture doc defers that to an
  unscheduled future admin panel; building it now for one endpoint would be
  the same kind of premature scaffolding CLAUDE.md's incremental-build rule
  rules out).
- The collections view (negative-balance users + originating chargeback).

It depends on `ledger` and `users` through their exported services only,
and publishes domain events for `notifications` to consume — never a direct
import, since `notifications` is peripheral.

This clears the same two-count bar ADR-0011/0014 used: an owned table
(`disputes`), and a genuinely distinct orchestration (dispute lifecycle,
not accounting and not P2P/withdrawal eligibility).

`ledger` gains exactly one new method:

```
postChargeback(walletId, amount, reference, reversesTransactionId, direction)
```

Balanced posting (`DEBIT user_wallet / CREDIT float_ngn` for a chargeback,
reversed direction for a resolved-in-favor re-credit), ascending
lock-ordering (trivial here — only two accounts), running-balance/
cached-balance maintenance, §4.3 invariant. Unlike every other debit-posting
path in the system, it does **not** enforce a sufficient-balance check —
going negative here is the entire point. It knows nothing about disputes,
freezing, or resolution state — only that a compensating entry was
requested by reference.

`users` gains a `freeze()`/`unfreeze()` pair setting the new `isFrozen`
column, called by `disputes` — never automatically from a balance crossing
zero via ordinary funding. Freezing and unfreezing are dispute-lifecycle
events, not balance-threshold events; a user who tops up to cover their
own negative balance stays frozen until the dispute that caused it actually
resolves (see docs/architecture.md §6 Phase 5 for the reasoning — this was
resolved as a real design question, not left as an accident of
implementation).

`transfers` and `withdrawals` each gain one more pre-check against
`UsersService`'s frozen status, at the same call site as their existing
PIN/eligibility checks — outbound spend is blocked while frozen, inbound
(funding, receiving P2P) is not.

## Alternatives considered

- **Grow `payments`.** The design's original assumption, invalidated by
  Kora having no chargeback webhook to receive. Even setting that aside,
  `payments` owns no tables (ADR-0008), and `disputes` needs one.
- **Grow `ledger`.** Rejected for the same reason ADR-0011/0014 rejected it
  for `transfers`/`withdrawals`: it would require importing `users` for the
  freeze call, destroying the zero-dependency property for no accounting
  benefit. The freeze/unfreeze and resolution orchestration is plainly not
  bookkeeping.
- **Grow `withdrawals` or `transfers`.** Rejected on the same
  reader-expectation and scope-creep grounds ADR-0014 used to keep
  withdrawal logic out of `transfers` — a reader would not look for
  chargeback/dispute handling inside either "P2P transfers" or "bank
  payouts," and neither module's existing responsibility has anything to
  do with disputes.
- **Freeze/unfreeze on balance threshold instead of dispute state.** Simpler
  to implement (no need to track *why* someone is frozen), but conflates
  "does this account currently have negative balance" with "is there an
  unresolved dispute" — a user could top up their way back into
  spend-access while a fraud investigation is still open, which defeats the
  actual purpose of freezing during a live dispute.

## Consequences

- Five modules now sit in the money path. ADR-0008's disambiguating question
  extends further: provider behaviour → `payments`; accounting treatment →
  `ledger`; P2P eligibility/identity/request lifecycle → `transfers`;
  withdrawal destination/orchestration → `withdrawals`; dispute
  ingestion/lifecycle/freeze orchestration → `disputes`.
- `disputes` must not depend on `transfers`, `withdrawals`, or any
  peripheral module — it only needs `ledger` and `users`.
- `transfers` and `withdrawals` gain a dependency on `users`' frozen-status
  check, which both already satisfy (both already depend on `users`) — no
  new cross-module edge, just a new call against an existing dependency.
- The `eslint-plugin-boundaries` rule set needs a `disputes-module` entry
  mirroring `transfers`/`withdrawals`' existing policies (disallow →
  peripheral modules).
- Phase 11's fraud work (`fraud_flags`, `confirmed` → `User.isFrozen`) reuses
  the `isFrozen` column and `freeze()`/`unfreeze()` methods this phase adds,
  rather than inventing its own account-hold mechanism — confirms the field
  belongs on `users`, not on a `disputes`-owned row.
- Real chargeback/dispute frequency is expected to be low (Nigerian bank
  transfers have no card-network-style chargeback mechanism; card funding
  carries real but modest dispute rates). This phase exists to close a gap
  Phase 2's external reconciliation job already flagged as a real failure
  mode it can detect but not resolve (docs/architecture.md §4.4's own
  example list names "a chargeback the provider processed that never
  reached Cliqpay"), not because volume justifies it on its own.
