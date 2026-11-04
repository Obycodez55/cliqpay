# ADR-0022: Entities are the schema's source of truth; migrations are generated from them and a CI check catches drift

**Status:** accepted
**Date:** 2026-11-04

## Context

Until now migrations were written by hand and entities described only part of the schema. Across all entities there were 23 `@Index`, 1 `@Unique` and 0 `@Check`, while the database held 23 CHECK constraints, 4 more unique constraints and 6 partial or otherwise undeclared indexes that existed only in migration SQL. A reader of an entity could not tell what the table enforced, and nothing noticed when the two disagreed.

The repo was already part-way to generation: `migration:generate` exists, `synchronize` is `false`, and `CliqpayNamingStrategy` produces readable deterministic constraint names instead of hashes. Running `migration:generate --check` against a database with every migration applied showed what a naive switch would have done: drop all 23 CHECKs, all 4 unique constraints and every undeclared index; rename 7 foreign keys to hashed names; and reorder the columns in the name of one composite index. Two defaults also disagreed (`push_tokens.last_used_at`, `users.kyc_tier`).

Generation has limits that shape the rules below, all confirmed against TypeORM 1.1.0:

- Column renames generate as drop + add, which loses data.
- CHECK constraints are matched by name only, so changing the expression of an existing `@Check` is invisible to the diff.
- Indexes are matched by name, uniqueness, type and column set, so changing an existing index's `where` predicate or the order of its columns is invisible to the diff. This was confirmed by changing the predicate of a partial unique index on an entity: the check still passed.
- `NULLS NOT DISTINCT` on an index is neither expressible on `@Index` nor read back from the database.
- Triggers, functions, seed rows and data backfills are not part of an entity at all.
- Without `uuidExtension`, TypeORM generates `uuid_generate_v4()` for new uuid primary keys; every existing migration uses `gen_random_uuid()`. With `uuidExtension: 'pgcrypto'` it generates `gen_random_uuid()`, and the diff against an already-migrated database is unchanged either way.

## Decision

1. **The entity describes the schema.** Everything TypeORM can express lives on the entity: columns and defaults, `@Index` (including `where`), `@Unique`, `@Check`, and same-module `@ManyToOne` relations (ADR-0002). The entity should read like the migration.
2. **Migrations are generated, then read and edited by hand.** The workflow is: change the entity, run `pnpm migration:generate`, read the SQL, add any hand-written parts, run `pnpm migration:run`, run `pnpm migration:check`. A generated migration is never run unreviewed and never auto-run in any environment. The rule that each migration maps to one real, current need still holds.
3. **Renames are hand-written.** A renamed column, table or constraint is written as `RENAME`, never accepted as the generated drop + add.
4. **What stays hand-written, because an entity cannot express it:**
   - triggers and functions (the `ledger_entries` append-only trigger);
   - seed rows (`tier_limits`, system accounts);
   - data backfills (the bank-account number encryption);
   - the `NULLS NOT DISTINCT` clause on `UQ_accounts_system`. The index is declared on the entity so the diff stays clean, but the clause lives only in its migration;
   - descending column order in an index, where `@Index` has no field for it.
5. **Value-list CHECKs are built from the same array as the TypeScript type.** A status or type column declares `export const X = [...] as const`, derives the union from it, and passes the array to a small `inList` helper that builds the `@Check` expression, so the type and the constraint cannot disagree. Native Postgres enum columns are not used: they would change every existing column, and removing a value from a native enum is much harder than replacing a CHECK.
6. **Naming strategy.** `CliqpayNamingStrategy` also names foreign keys (`FK_<table>_<cols>`) and unique constraints (`UQ_<table>_<cols>`), and no longer sorts index columns, so generated names match the existing readable ones.
7. **`uuidExtension: 'pgcrypto'`** is set on the DataSource.
8. **A CI check enforces it.** `pnpm migration:check` runs `migration:generate --check` against a database with all migrations applied and exits non-zero on any difference, printing the would-be migration and a message pointing at this ADR. CI runs it in a dedicated job with a Postgres 16 service container, separate from the integration suite.
9. **Some edits are invisible to the check.** The diff cannot see a changed CHECK expression, a changed index `where` predicate, or reordered index columns. Editing any of those needs a hand-written migration (drop and re-add, or `CREATE INDEX` of the new definition) and the entity edit in the same PR; the reviewer verifies both. Adding a value to an `as const` array updates the entity side automatically, but not the database.

## Alternatives considered

- **Keep writing migrations by hand.** Rejected: it is how the entity and database came to describe different schemas, and nothing would stop it recurring.
- **Auto-run generated migrations or use `synchronize`.** Rejected: renames become data loss and a ledger needs a human to read every change.
- **Native Postgres enum columns instead of CHECKs.** Rejected for the reasons in decision 5.
- **A separate test comparing each entity `@Check` and index predicate with the database, to close the blind spots.** Deferred: the by-hand rule in decision 9 is enough for now, and the test can be added if a CHECK ever drifts silently.
- **Run the drift check inside the integration job.** Rejected: a dedicated job runs in parallel, needs only a Postgres service container, and does not depend on how the integration suite provisions its database.

## Consequences

- Entities become longer, since they now carry every constraint, but a reader no longer needs the migration SQL to know what a table enforces.
- A schema change that forgets to update the entity, or the migration, fails CI with the would-be migration printed.
- The exception list in decision 4 is known up front; anything else that cannot be expressed on an entity belongs on it, with a note.
- The one-time parity pass corrects entities to match the database. The only migration it needed is a no-op respelling of the `push_tokens.last_used_at` default (`CURRENT_TIMESTAMP` to `now()`): TypeORM normalizes an entity default of `CURRENT_TIMESTAMP` to `now()`, so no entity expression can match the original text.
