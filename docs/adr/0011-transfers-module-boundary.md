# ADR-0011: A `transfers` module — orchestration lives outside the books

**Status:** accepted
**Date:** 2026-08-01

## Context

ADR-0008 drew the `ledger` / `payments` line: `ledger` is the books,
`payments` is the rails. Phase 3's P2P transfer fits neither description
cleanly, because it touches no provider at all — money never leaves
Cliqpay's system (docs/architecture.md §4.2) — while still needing work that
is plainly not accounting.

A transfer requires: verifying a transaction PIN (`auth`), resolving a
recipient from a username or email (`users`), checking an idempotency
fingerprint, posting balanced entries, then publishing domain events. Only
one of those is bookkeeping.

The constraint that decided this is a property `ledger` currently has and
which nothing in the codebase names: **`ledger` imports nothing from any
other module.** Its entire import surface is TypeORM, the `Money` primitive,
its own entities, and shared infrastructure. It is the only module in the
system with no peer dependencies, which is what makes it testable in
isolation and what makes ADR-0008's "books" description literally true rather
than aspirational.

Phase 3 also introduces `money_requests` — a table that is not a transaction
until it is paid, and therefore not the ledger's to own.

CLAUDE.md's anti-proliferation rule points the other way here, and it does so
correctly rather than incidentally: "Don't spin up a new module/service pair
for a capability that's really one more method on something that already
exists." That rule is why this decision needed writing down instead of just
making.

## Decision

A new `transfers` module owns P2P orchestration, the `money_requests` table,
and the HTTP surface for both. It depends on `ledger`, `auth`, and `users`
through their exported services only.

`ledger` gains exactly one new method:

```
postTransfer(senderWalletId, recipientWalletId, amount, platformFee, reference)
```

Balanced posting, ascending-`account_id` lock ordering, running-balance and
cached-balance maintenance, and the §4.3 invariant. It knows nothing about
PINs, usernames, requests, or who is allowed to send. Everything about *who*
and *whether* lives in `transfers`.

`ledger` keeps its zero peer-dependency property. That property is now a
stated invariant of the module rather than an accident of what has been
built so far.

## Alternatives considered

- **Grow `ledger`.** The option CLAUDE.md's rule actually favours, and the
  reason this ADR exists. Rejected because it requires `ledger` to import
  `auth` and `users`, which destroys the zero-dependency property and puts
  PIN verification inside the accounting layer. The rule's purpose is to
  avoid paying a module's overhead for what is really a method; here the
  overhead buys back the cleanest boundary in the codebase, so the trade runs
  the other way. The rule's own carve-out — "a genuinely distinct
  responsibility" — is met on two independent counts: an owned table, and
  the first user-initiated-debit orchestration in the system.
- **Put it in `payments`.** Structurally the path of least resistance:
  `payments` already imports `users` and `ledger` and already orchestrates a
  money flow. Rejected on two explicit ADR-0008 grounds — `payments` owns no
  tables, and `money_requests` is a table; and `payments` is defined as the
  *provider* rails, while a P2P transfer touches no provider. ADR-0008's own
  test settles it: would this code change if Kora changed its API? No. Would
  it change if the accounting treatment changed? Also no. It belongs to
  neither.

## Consequences

- Three modules now sit in the money path, and a reader has to know which
  owns what. ADR-0008's disambiguating question extends accordingly: provider
  behaviour changes → `payments`; accounting treatment changes → `ledger`;
  eligibility, identity, or request lifecycle changes → `transfers`.
- Phase 4's withdrawal spans `payments` (payout rails) and `ledger`
  (posting), and should *not* be folded into `transfers` — despite the name,
  this module is about user-to-user movement, not about every debit.
- Phase 8's bill splitting builds on money requests and will depend on
  `transfers`, so `transfers` must not grow a dependency on any peripheral
  module.
- The zero-dependency rule for `ledger` is now load-bearing and worth
  enforcing mechanically. `eslint-plugin-boundaries` is already configured;
  a rule pinning `ledger`'s allowed imports would catch a future violation
  that review might not.
