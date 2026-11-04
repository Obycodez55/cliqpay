# ADR-0023: One migrated Postgres per integration run, cloned per spec file

**Status:** accepted
**Date:** 2026-11-04

## Context

Every integration spec file starts its own Postgres container (56 Postgres starts in a full run of 52 suites) and each test context applies a hand-listed subset of the migrations by calling `new XMigration().up(queryRunner)` directly. Consequences seen so far:

- Adding one migration (`AddKycTierToUsers`) meant editing seven context files.
- A context that forgets a migration still passes, silently skipping a unique index or CHECK constraint. Several contexts already skip `DropUserForeignKeys`, so they test against foreign keys production does not have.
- Tests never go through the real migration runner (ordering, the migrations table), so they exercise something slightly different from production.
- More containers means more Docker-contention flakiness, and Ryuk is disabled in CI, so every container needs explicit teardown.

## Decision

1. **One Postgres container per Jest invocation.** A Jest `globalSetup` starts it, creates a `cliqpay_template` database, and runs `DataSource.runMigrations()` on a DataSource built from `buildDataSourceOptions`, the same definition production and the CLI use. It then closes that connection and marks the database `IS_TEMPLATE` with `ALLOW_CONNECTIONS false`, so nothing can connect to it and `CREATE DATABASE ... TEMPLATE` never fails on "source database is being accessed by other users".
2. **Each spec file gets its own database cloned from the template** (`CREATE DATABASE ... TEMPLATE cliqpay_template`) through one support helper, and drops it when its context is destroyed. Isolation between files is the same as with a container per file: separate database, separate rows, separate sequences.
3. **Connection details reach workers as environment variables** set by `globalSetup`. Jest spawns workers after `globalSetup`, so they inherit them; no state file needs writing or cleaning up.
4. **Contexts carry no migrations.** They keep module wiring and seed helpers only, so a new migration needs no edit under `test/integration/support/`. Specs always run against the full schema.
5. **Teardown is explicit.** `globalTeardown` stops the container and verifies it is gone. `globalSetup` also registers SIGINT/SIGTERM handlers that stop it, because Jest does not run `globalTeardown` when interrupted. A SIGKILL can still leak one container, as it can today with Ryuk off.
6. **Redis is unchanged**: still one container per file. BullMQ queue names are fixed, so a shared Redis would let one file's workers consume another file's jobs.

## Alternatives considered

- **Container per file with `runMigrations()` in each context.** Fixes the hand-listed migrations but keeps the 56 container starts and the contention they cause.
- **One database, truncate between files.** Files run in parallel workers, so they would trample each other's rows; serialising the suite costs more than it saves.
- **A schema per file instead of a database per file.** Cloning a template database copies the whole migrated schema in one statement; per-schema setup would need migrations replayed per schema and search-path handling in every connection.
- **Connection details through a state file.** More moving parts (a file to write, locate and delete) for no benefit over inherited environment variables.
- **Sweeping stale labelled containers at startup.** Would also kill another worktree's concurrent run; not worth the risk for a leak that only follows a SIGKILL.

## Consequences

- One container start and one migration run per invocation; the migration list can no longer drift from production.
- Specs now see every constraint and foreign-key change production has. A spec that relied on a missing constraint will fail and must be fixed, not worked around.
- The template database must never be connected to after setup; a helper that needs the schema clones it.
- Integration runs depend on `globalSetup`, so running a single spec still starts the shared container (one start instead of one per context).
- Out of scope here: sharing Redis, and putting the real exception filter and response interceptor into the contexts, which is done as a separate final slice so test counts can first be shown identical.
