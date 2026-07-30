# Cliqpay

A production-grade peer-to-peer wallet platform for Africa (Nigeria first) — NestJS, PostgreSQL, TypeORM, integrated with Kora. Full design: [docs/architecture.md](docs/architecture.md). Read it before touching the ledger, auth, or payments modules — this file only holds the operating rules, not the design itself. For *how* to run a phase end-to-end (design → issues → implementation → audit → e2e), see [docs/phase-playbook.md](docs/phase-playbook.md) — read it before starting a new phase.

## Git — hard rules

- **Never put my (Claude's) name anywhere** — not in commit authorship, not in commit messages, not in code comments, not in docs. No `Co-Authored-By: Claude`, no attribution lines.
- **Never commit without the user reviewing the diff first.** Stage and prepare changes, show what would be committed, and wait for explicit go-ahead before running `git commit`. This applies every time, not just once per session.
- Never push, force-push, or amend published commits without explicit instruction.

## Workflow

- **Present a plan before implementing anything non-trivial or structural** — new dependencies, restructuring existing files/modules, schema or config shape changes, new architectural patterns (e.g. a naming strategy, a shared factory). Lay out the approach and wait for explicit go-ahead before writing code. Small, obviously-scoped fixes within a single file don't need this.

## Build incrementally, not upfront

`docs/architecture.md` documents the *full* target design — the whole schema (§5), every config namespace eventually needed, the complete phased feature list. That's a design reference, not a build order (the doc says this explicitly in §6). Nothing described there gets scaffolded until the specific task in front of you actually needs it. This isn't only about code abstractions (see General conventions below) — it applies just as much to schema and data:

- **Schema**: create an entity/table/migration only when the module being built that session needs it. Building Phase 1 auth doesn't mean also scaffolding `ledger_entries` because §5 documents it — that comes with the ledger module, in the ledger module's own phase. Each migration should map to one real, current need, not a chunk of the eventual full schema.
- **Config**: already the working pattern in `src/config/config.ts` — a namespace (`jwt`, `kora`, `encryption`, `brevo`, etc.) gets added in the same change that wires it up, never speculatively ahead of that.
- **Domain events**: already the working pattern in `src/shared/events/domain-events.ts` — payload types accumulate as modules need to publish them, not as a pre-built catalog.
- **The tell**: if the reason for adding something is "the architecture doc mentions it eventually" rather than "the thing I'm building right now needs it," stop and check whether it actually belongs in this change.

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

**`ledger` is the books; `payments` is the rails.** `ledger` owns `accounts`/`transactions`/`ledger_entries` and every write to them, plus the §4.2 posting rules and the §4.3 invariant — it knows nothing about providers, webhooks, or checkout URLs. `payments` owns provider adapters, webhook verification, polling, and reconciliation, and owns **no tables** — it hands `ledger` provider facts and lets `ledger` decide what they post to. When it's unclear where code goes: would it change if Kora changed its API (→ `payments`) or if the accounting treatment changed (→ `ledger`)? Nothing answers yes to both. See [ADR-0008](docs/adr/0008-ledger-payments-boundary.md).

**Show relationships in the schema as explicitly as possible.** Every same-module foreign key gets a real FK constraint in its migration *and* an additive TypeORM relation decorator (`@ManyToOne`/`@JoinColumn`) alongside the plain `xId` column — added proactively when the FK itself is created, not deferred until some caller happens to need the join. Cross-module references never get either (see above) — see [ADR-0002](docs/adr/0002-cross-module-references-and-relation-decorators.md) for the full reasoning and the module-boundary line this draws.

## Testing

- **Unit (TDD)** — ledger math, fee calculations, limit windows. Co-located `__tests__/` per module.
- **Integration** — full service methods against a real test Postgres (Testcontainers), not mocks. `test/integration/`.
- **Contract** — `KoraAdapter`/`KoraSandboxKycProvider` against Kora's real sandbox, confirming the fakes still match reality. `test/contract/`, nightly/pre-release cadence, not per-commit.
- **Property-based** — random valid operation sequences must never break the ledger invariant (§4.3 of the architecture doc), using `fast-check`.

Every PR: lint + unit + integration. Nightly/pre-release only: contract tests + higher-iteration property fuzzing.

Integration spec files are scoped per feature area, not left to grow as one file per module — split when a file's covering several unrelated flows, not by a line-count threshold. Share the expensive setup (app bootstrap, Testcontainers, common request helpers) through a test-support module the split files import, rather than duplicating it or avoiding the split to save that cost.

## General conventions

- Don't add abstractions, error handling, or config beyond what the current phase actually needs — see the architecture doc's phased plan before building ahead of it.
- Comments only where the *why* isn't obvious from the code (a workaround, a non-obvious invariant) — never comments that restate what the code does. Don't cite an issue number, ADR, or doc section as a stand-in for the reasoning itself — either the *why* is worth a short sentence inline, or it doesn't need a comment at all. A reader shouldn't have to go open something else to find out why a line exists.
- **Don't spin up a new module/service pair for a capability that's really one more method on something that already exists.** A new file is a bigger commitment than a new method — more DI wiring, another public surface to reason about, another thing for module-boundary rules to govern. Before scaffolding `<thing>.module.ts` + `<thing>.service.ts`, check whether the closest existing module or shared service (e.g. `src/shared/events/event-bus.service.ts`) can just grow a method instead. Reserve a new module for a genuinely distinct responsibility, not for "this is a different queue" or "this is a different flavor of the same infra."
