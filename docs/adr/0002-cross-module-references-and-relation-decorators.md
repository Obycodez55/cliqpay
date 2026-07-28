# ADR-0002: Cross-module references stay plain UUIDs; TypeORM relations only where a real FK exists

**Status:** accepted
**Date:** 2026-07-21

## Context

`docs/architecture.md` §10 already states the module-boundary rule: "cross-module references are plain UUIDs, never a DB-level foreign key." That's been followed in practice since Phase 1 — `Account.userId` (`ledger` → `auth`) and `PushToken.userId` (`notifications` → `auth`) are both plain `uuid` columns with no FK constraint.

What wasn't written down anywhere is the entity-modeling consequence of that rule: no entity in this codebase uses a TypeORM relation decorator (`@ManyToOne`, `@OneToMany`, `@JoinColumn`) — not even `Session.userId` → `User`, which *is* same-module (`auth` → `auth`) and does get a real FK constraint in its migration (`CreateSessions`). Without this ADR, that looked like either an oversight or an unstated blanket rule, and came up as a direct question once `Session` was added.

## Decision

Two rules, applied together:

1. **Whether a real DB foreign key exists is governed purely by the existing module-boundary rule** (architecture.md §10): same-module reference → real FK in the migration (e.g. `Session.userId` → `users.id`, both in `auth`). Cross-module reference → no FK, ever (e.g. `Account.userId`, `PushToken.userId` → `users.id`, referencing `auth` from `ledger`/`notifications`) — a cross-module FK can't survive that table moving to its own service/database later, so it's never created in the first place rather than removed after the fact.
2. **A TypeORM relation decorator is added only when a real FK backs it**, and only additively alongside the existing plain `@Column('uuid') xId` — never replacing it, never eager, never the only way to read the id. `Session.user` (`@ManyToOne(() => User) @JoinColumn({ name: 'user_id' })`) is the first and, as of this writing, only example. A relation decorator on a cross-module column would misrepresent a constraint that doesn't exist in the database, so it's never used there — `Account.userId` / `PushToken.userId` stay plain columns permanently, not just until someone gets around to it.

This is a broader instance of the same reasoning behind the modular-monolith structure in general: keep the option to physically split a module open, and don't let convenience (an eager-loadable relation, a FK-enforced join) quietly reintroduce the coupling the module boundaries exist to prevent.

**[2026-07-21, amended]** Rule 2 above was written from `Session.user`'s example and read as reactive — add a relation once some caller happens to want a join. Clarified during issue #4's review: the default is proactive. Every same-module FK gets its additive relation decorator at the point the FK itself is added in the migration, not deferred until a query needs it — the schema should show its relationships as directly as it can, and a caller that never ends up using `relations: [...]` costs nothing for the decorator having been there. `MfaChallenge.method`, `MfaMethod.user`, and `TrustedDevice.user` (all issue #4) are the first entities built under this reading; `Session.user`/`Session.trustedDevice` remain correct under it too, just no longer read as exceptional.

## Alternatives considered

- **FK constraints and relation decorators everywhere, module boundaries be damned** — rejected; this is the normal default for a single-database app with no split planned, but it's explicitly not this project's bet (see architecture.md §10's own reasoning about future extraction), and it would silently reintroduce a hard dependency between modules that the lint-enforced import boundary is supposed to prevent at the code level.
- **Relation decorators without real FKs, to get TypeORM's join/eager-load ergonomics across module boundaries too** — rejected; a relation decorator implies referential integrity to anyone reading the entity, and there wouldn't be any. Misleading is worse than inconvenient.
- **No relation decorators at all, ever, even same-module** — this was the status quo until `Session` prompted the question. Rejected going forward: where a real constraint exists, expressing it as a relation is strictly more informative and doesn't cost anything (it's additive, not eager, and doesn't change how the plain id column is used elsewhere in the code).

**[2026-07-27, amended]** `User` moved out of `auth` into its own `users`
core module (see ADR-0005). `Session.userId`, `VerificationCode.userId`,
`MfaMethod.userId`, and `TrustedDevice.userId` — all same-module real FKs
to `users(id)` when this ADR was written — became cross-module references
the moment that move happened, since `users(id)` no longer lives in the
same module as any of those four tables. Per rule 1 above, a real FK
can't survive a table moving to its own module, so all four FK constraints
were dropped (`DropUserForeignKeys` migration) and their relation
decorators (`Session.user`, `MfaMethod.user`, `TrustedDevice.user`) removed
— the same treatment `Account.userId`/`PushToken.userId` already had from
day one, not an exception to this ADR's rules but exactly what they predict
for a same-module reference that stops being same-module. `MfaChallenge.method`
(→ `mfa_methods`, still `auth`-internal) is unaffected.

## Consequences

- A cross-module dangling reference (e.g. an `Account.userId` pointing at a deleted/nonexistent user) is not caught by the database — it has to be caught by application logic or tests, not a constraint. This is an accepted, standing trade-off, not a gap to eventually close.
- Same-module relations (currently just `Session.user`) are discoverable via the entity and can be joined with `relations: [...]` or a query builder join when a caller actually wants the related row — but nothing loads it implicitly, so existing code that only reads the scalar `xId` column is unaffected.
- Any future same-module FK (e.g. if a later `auth` entity references `User` directly) should get the same additive relation-decorator treatment for consistency. Any future cross-module FK temptation should be resolved the same way it always has: no FK, no relation, plain UUID.
