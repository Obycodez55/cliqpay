# ADR-0014: A `withdrawals` module owns `bank_accounts` and payout orchestration

**Status:** accepted
**Date:** 2026-08-16

## Context

ADR-0011 placed Phase 4's withdrawal across `payments` (payout rails) and
`ledger` (posting), and explicitly ruled out folding it into `transfers` —
but didn't say where the parts that are neither rails nor books actually
live: saving a bank account, resolving it against Kora, and orchestrating
the withdrawal request (PIN check, idempotency, calling `payments`, calling
`ledger`, publishing events).

Working through ADR-0008's boundary test for the new `bank_accounts` table:

- **`ledger`** — would `bank_accounts` change if the accounting treatment
  changed? No. Would it change if Kora changed its resolve API or bank code
  list? Yes. `ledger` also has a zero-peer-dependency property (ADR-0011)
  that a provider-tied table would compromise for no accounting benefit.
- **`payments`** — ADR-0008 states `payments` owns no tables, full stop.
  That rule already forced `money_requests` out of `payments` in Phase 3;
  it applies identically here.

Neither module can take it, which is the same shape of problem ADR-0011
solved for `transfers` — and CLAUDE.md's anti-proliferation rule applies
the same way: a new module is only justified if the capability is a
genuinely distinct responsibility, not a convenience split.

## Decision

A new `withdrawals` module owns the `bank_accounts` table and withdrawal
orchestration (transaction PIN check, idempotency, save/resolve, initiate,
webhook handling, history). It depends on `payments`, `ledger`, and `auth`
through their exported services only — never `transfers`, and never the
reverse.

This clears the same two-count bar ADR-0011 used for `transfers`: an owned
table (`bank_accounts`), and a second, independent user-initiated-debit
orchestration in the system (withdrawal, distinct from P2P transfer).

`ledger` gains exactly one new method:

```
postWithdrawal(walletId, amount, platformFee, providerFee, reference)
```

Balanced 5-leg posting per docs/architecture.md §4.2 (Withdrawal), ascending
lock ordering, running-balance/cached-balance maintenance, §4.3 invariant.
It knows nothing about bank accounts, Kora, or payout status — only that a
withdrawal debit was requested by reference.

`payments` gains `resolveBankAccount()`, `initiatePayout()`, and payout
webhook verification on `PaymentProviderAdapter`, mirroring the existing
`initiatePayment()`/webhook shape. It knows nothing about `bank_accounts`
as a persisted entity — it takes bank details as parameters and returns
provider results; `withdrawals` is what persists and orchestrates.

## Alternatives considered

- **Grow `payments`.** Structurally tempting — `payments` already imports
  `ledger` and already calls Kora. Rejected on the same ADR-0008 ground that
  kept `money_requests` out: `payments` owns no tables, and `bank_accounts`
  is a table with its own lifecycle (save, resolve, list), not a
  provider-call parameter.
- **Grow `transfers`.** Rejected explicitly by ADR-0011's own consequences
  section — despite the shared "money leaves a wallet" shape, `transfers` is
  about user-to-user movement and must not become a catch-all for every kind
  of debit, or it starts accumulating the same peripheral-dependency risk
  `ledger`'s zero-dependency rule exists to prevent.
- **Grow `ledger`.** Rejected for the same reason ADR-0011 rejected it for
  transfers: it would require `ledger` to import `auth` (PIN check) and know
  about bank accounts, destroying the zero-dependency property for no
  accounting benefit.

## Consequences

- Four modules now sit in the money path. ADR-0008's disambiguating question
  extends further: provider behaviour → `payments`; accounting treatment →
  `ledger`; P2P eligibility/identity/request lifecycle → `transfers`;
  withdrawal destination/orchestration → `withdrawals`.
- Phase 5's chargeback/negative-balance work touches `ledger` and freezes
  accounts (`users`/`auth`); it has no dependency on `withdrawals` and
  should not gain one.
- `withdrawals` must not depend on `transfers` or any peripheral module,
  matching the same constraint already placed on `transfers` itself.
- The `eslint-plugin-boundaries` rule pinning `ledger`'s allowed imports
  (ADR-0011) needs a corresponding entry for `withdrawals`' allowed imports
  (`payments`, `ledger`, `auth`, `users` — not `transfers`).
