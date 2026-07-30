# ADR-0008: The `ledger` / `payments` boundary — books vs. rails

**Status:** accepted
**Date:** 2026-07-30

## Context

Issue #12 (funding initiation) was the first change to put `ledger` and
`payments` in the same flow, and it surfaced that the line between them had
never actually been drawn — only implied. The implementation is lint-clean
(`eslint-plugin-boundaries` passes; `PaymentsService` reaches `ledger` only
through its exported service), which is exactly why this needs writing down:
the drift here is semantic, not structural. Nothing mechanical was going to
catch it.

Three symptoms made the missing definition visible:

1. `/v1/wallet` ended up served by two controllers in two modules —
   `WalletController` (`ledger`) for `GET /wallet/balance`, and a
   `PaymentsController` (`payments`) for `POST /wallet/fund`.
2. `PaymentsService` stores its checkout URL in `Transaction.metadata` (a
   `Record<string, unknown>` owned by `ledger`) and reads it back out as
   `existing.metadata.checkoutUrl as string` — a payments-owned concept
   round-tripping through a ledger table via an unchecked cast.
3. Issue #13, as originally written, specified
   `PaymentsService.completeFundingTransaction()` posting the four §4.2
   ledger entries. That would have put double-entry posting knowledge —
   including which accounts a funding credits — inside `payments`.

The third is the expensive one. Issues #14 (poll-based completion) and #15
(reconciliation) both build directly on that method, so a wrong boundary
there would have been load-bearing for three issues before anything forced
the question.

docs/architecture.md already leans a particular way on this, in two places
easy to read past:

- §10 lists which modules own tables: "**Ledger**, Auth, KYC, Fraud, Social,
  BillSplit, and Scheduling each own a clearly scoped set of tables."
  `payments` is absent from that list.
- §10's directory tree draws `payments/` containing only `adapters/` — no
  service, no controller, no `entities/`.

Neither is stated as a rule, so this ADR makes it one.

## Decision

**`ledger` is the books. `payments` is the rails.**

**`ledger`** owns `accounts`, `transactions`, and `ledger_entries`, and owns
every write to them. It owns the §4.2 posting rules — which entries a given
transaction type produces — and the §4.3 invariant. It knows nothing about
payment providers, HTTP, checkout URLs, webhooks, or signature schemes. Its
correctness is fully testable with no network.

**`payments`** owns the `PaymentProviderAdapter` interface and its
implementations, webhook receipt and signature verification, the
self-verify poll job, and provider-balance reconciliation. **It owns no
tables.** It translates provider reality into calls on `LedgerService`. It
never names a system account.

**The seam:** `payments` hands `ledger` *provider facts* — reference, net
amount, provider fee, provider name, resolved status. `ledger` decides what
those facts post to. A method like `LedgerService.postFunding()` lives in
`ledger` and is called by `payments`; the reverse — `payments` assembling
debits and credits — is the thing this ADR exists to rule out.

The practical test when it's unclear where something goes: *would this code
need to change if Kora changed its API?* If yes, it's `payments`. *Would it
need to change if the accounting treatment changed?* If yes, it's `ledger`.
Nothing should answer yes to both.

### Both modules serve `/v1/wallet`, deliberately

`/v1/wallet` stays one URL namespace served by two controllers, split by
this rule: **`ledger` serves what needs no provider; `payments` serves what
does.**

At Phase 3–4 that gives `ledger` balance, transaction history, and P2P send
(pure ledger movement, no external rail), and `payments` fund and withdraw.
`@ApiTags('Wallet')` on both is correct rather than duplicated — Swagger
groups by tag, and a user should see one Wallet section regardless of which
module happens to serve a given route.

The `payments` controller stays `payments.controller.ts` /
`PaymentsController` — named after the module, the same pattern
`auth.controller.ts` already uses as `auth`'s primary controller. It isn't
named after `fund` specifically: Phase 4 lands withdrawal on this same
controller, another provider-backed `/wallet` route, so a fund-specific name
would need re-litigating the moment that arrives. The namespace being
shared with `ledger`'s `WalletController` is documented here, in this ADR
and in CLAUDE.md — it doesn't need to be re-derivable from the class name
itself.

## Alternatives considered

- **Consolidate all `/v1/wallet` routes into `ledger`.** Rejected — it
  forces `ledger → payments`, so the module that owns money correctness
  would import the module that owns HTTP calls to Kora. That inversion is
  the one thing this whole split exists to prevent.
- **Consolidate all `/v1/wallet` routes into `payments`.** Rejected — it
  leaves `ledger` with no HTTP surface (defensible on its own, and closer to
  §10's tree) but puts `GET /wallet/balance`, a pure ledger read with no
  provider involvement, inside a module named "payments." The dependency
  direction is legal; the naming becomes a lie.
- **A third `wallet` module owning the user-facing surface, depending on
  both.** Rejected — it would be a controller plus a service that delegates,
  which is a layer, not a responsibility. CLAUDE.md's rule against spinning
  up a module/service pair for what isn't a distinct responsibility targets
  exactly this shape.
- **Move funding out of `/v1/wallet` to its own namespace** (`POST
  /v1/funding`), giving each module a namespace it owns outright. Rejected —
  it buys internal tidiness by making the public API worse: `GET
  /wallet/balance` alongside `POST /funding` splits one coherent user-facing
  resource across two namespaces for reasons that are purely about our
  internal module layout.
- **Let `payments` own a `payment_attempts` table** for in-flight provider
  state, leaving `transactions` untouched until something succeeds.
  Rejected — §5 already models `status` on `transactions` with a `pending`
  value, so pending rows are the intended design; a parallel table would
  duplicate the idempotency anchor (`UQ_transactions_reference`) and create
  two places to look for "did this funding attempt happen."

## Consequences

- Issue #13 is rewritten before implementation: the completion method moves
  to `LedgerService`, with `payments` supplying only provider facts. Issues
  #14 and #15 inherit the corrected shape rather than building on the wrong
  one.
- `Transaction.metadata` stops being an untyped `Record<string, unknown>`
  that any module can stuff anything into. It becomes a per-transaction-type
  typed shape, so a payments-owned field like `checkoutUrl` is checked at
  compile time rather than cast at the read site. This is a change to code
  already written for #12.
- `payments` keeps its exported `PaymentsService` even though it owns no
  tables — the one-exported-service rule (§10) is about the public surface,
  not about persistence. A module that owns only behavior still gets exactly
  one door.
- `payments` now depends on `ledger` *and* `users` (for the customer email
  Kora requires). Both are core → core, one-way, no cycle — the property
  ADR-0005 established as the thing that matters.
- The "would it change if Kora changed its API" test gives Phase 4
  (withdrawals) and Phase 6 (KYC) a decision procedure that already exists,
  rather than relitigating the boundary each time a new provider capability
  lands.
