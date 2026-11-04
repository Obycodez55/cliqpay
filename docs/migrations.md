# Writing a migration

Entities are the schema's source of truth and migrations are generated from them — see [ADR-0022](adr/0022-entities-as-schema-source-of-truth.md) for why, and for what stays hand-written. This is the step-by-step.

## Workflow

Needs a local Postgres 15 or newer (one existing index uses `NULLS NOT DISTINCT`) with every existing migration applied: `pnpm migration:run`.

1. **Change the entity.** Columns, defaults, `@Index` (with `where`), `@Unique`, `@Check` (value lists via `inList` and an `as const` array), same-module `@ManyToOne` all go on the entity.
2. **Generate.** `pnpm migration:generate src/database/migrations/<DescriptiveName>` writes a timestamped file. Run `npx prettier --write` on the new file afterwards.
3. **Read the SQL.** Never run a generated migration unread. Look for:
   - a `DROP COLUMN` / `DROP TABLE` / `DROP CONSTRAINT` paired with an `ADD` of something similar: that is a rename (see below);
   - anything touching `ledger_entries` that is an `UPDATE` or `DELETE`: never allowed, corrections are compensating transactions;
   - an unexpected change to something you did not edit.
4. **Add the hand-written parts** the entity cannot express: seed rows, triggers and functions, data backfills, `NULLS NOT DISTINCT`, descending index columns. Put them in the same migration, or in their own `pnpm migration:create` file if they are unrelated to the schema change. Keep the `down` correct.
5. **Run it.** `pnpm migration:run`, then `pnpm migration:revert` and `pnpm migration:run` again to prove `down` works.
6. **Check.** `pnpm migration:check` must print "No changes in database schema were found". CI runs the same check against an empty database with every migration applied.

A migration is never run automatically in any environment; applying one is a deliberate step.

## Renames are hand-written

TypeORM cannot tell a rename from a drop plus an add, and for a column that is data loss. Rename the property on the entity, generate, then **replace** the generated drop + add with:

```ts
await queryRunner.query(`ALTER TABLE "t" RENAME COLUMN "old_name" TO "new_name"`);
```

and the reverse in `down`. The same goes for tables (`RENAME TO`) and constraints or indexes (`RENAME CONSTRAINT`, `ALTER INDEX … RENAME TO`).

## Edits the check cannot see

`pnpm migration:check` does not notice a changed CHECK expression, a changed index `where` predicate, or reordered index columns. When you edit one of those, write the migration yourself (drop and re-add the constraint, or recreate the index) and make the matching entity edit in the same change. If you forget either half, nothing fails, so state both in the PR description.
