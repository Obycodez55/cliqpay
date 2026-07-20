# Cliqpay

A production-grade peer-to-peer wallet platform for Africa (Nigeria first) — NestJS, PostgreSQL, TypeORM, integrated with Kora. Full design: [docs/architecture.md](docs/architecture.md). Read it before touching the ledger, auth, or payments modules — this file only holds the operating rules, not the design itself.

## Git — hard rules

- **Never put my (Claude's) name anywhere** — not in commit authorship, not in commit messages, not in code comments, not in docs. No `Co-Authored-By: Claude`, no attribution lines.
- **Never commit without the user reviewing the diff first.** Stage and prepare changes, show what would be committed, and wait for explicit go-ahead before running `git commit`. This applies every time, not just once per session.
- Never push, force-push, or amend published commits without explicit instruction.

## Workflow

- **Present a plan before implementing anything non-trivial or structural** — new dependencies, restructuring existing files/modules, schema or config shape changes, new architectural patterns (e.g. a naming strategy, a shared factory). Lay out the approach and wait for explicit go-ahead before writing code. Small, obviously-scoped fixes within a single file don't need this.

## Non-negotiable engineering rules (from docs/architecture.md)

- **Money is always integer minor units** (`bigint`) — kobo, cents, etc. Never `decimal`, never floating point. All money math goes through a single `Money` helper, never scattered arithmetic.
- **Double-entry only.** Every transaction posts balanced debits and credits across ≥2 accounts. `ledger_entries` is append-only — never `UPDATE`/`DELETE`, including in migrations. Corrections are compensating transactions, never mutations of history.
- **`accounts.balance` is a cache**, not a source of truth — it must equal the `running_balance` of that account's latest `ledger_entries` row, written in the same DB transaction, from the same computation, in exactly one place in code.
- **Lock ordering:** any operation locking multiple wallet rows locks them by `account_id` ascending, regardless of direction. Lock → check balance → write debit. Never check-then-lock.
- **Idempotency:** client-initiated money movements require a client-supplied idempotency key (`reference`); webhook-initiated ones dedupe against the provider's own reference (`provider_reference`).
- **Provider-agnostic at the data layer.** No provider name baked into account identifiers — use the `provider` column. Provider-specific logic (webhook verification, payout calls, KYC calls) lives behind the `PaymentProviderAdapter` / `KycProvider` interfaces, never scattered through services.
- **No secrets committed.** API keys, encryption keys, and credentials come from environment-injected config only — see `.env.example` for the required shape.

## Module structure

Modular monolith, one exported service per module (`src/modules/<name>/<name>.service.ts` is the only importable surface — everything else in the module is internal). Core modules (`ledger`, `payments`, `auth`) never import from peripheral ones (`fraud`, `social`, `billsplit`, `scheduling`); peripheral modules depend on core via its exported service only. Cross-module references are plain UUIDs, not DB foreign keys. Cross-module side effects are async domain events published through the shared BullMQ event bus, published *after* the originating transaction commits — never inside it.

## Testing

- **Unit (TDD)** — ledger math, fee calculations, limit windows. Co-located `__tests__/` per module.
- **Integration** — full service methods against a real test Postgres (Testcontainers), not mocks. `test/integration/`.
- **Contract** — `KoraAdapter`/`KoraSandboxKycProvider` against Kora's real sandbox, confirming the fakes still match reality. `test/contract/`, nightly/pre-release cadence, not per-commit.
- **Property-based** — random valid operation sequences must never break the ledger invariant (§4.3 of the architecture doc), using `fast-check`.

Every PR: lint + unit + integration. Nightly/pre-release only: contract tests + higher-iteration property fuzzing.

## General conventions

- Don't add abstractions, error handling, or config beyond what the current phase actually needs — see the architecture doc's phased plan before building ahead of it.
- Comments only where the *why* isn't obvious from the code (a workaround, a non-obvious invariant) — never comments that restate what the code does.
