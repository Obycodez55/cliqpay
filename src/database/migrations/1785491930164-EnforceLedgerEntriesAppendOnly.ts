import { MigrationInterface, QueryRunner } from 'typeorm';

// CLAUDE.md calls `ledger_entries` append-only "non-negotiable," but until
// now that was application-level convention only — nothing stopped a
// migration, a manual fix, or a bug from UPDATE/DELETE-ing a row (Phase 2
// audit, L2). A trigger makes it physically impossible instead of just
// conventionally forbidden — the DB itself refuses, regardless of which
// code path (or lack of one) issues the statement.
export class EnforceLedgerEntriesAppendOnly1785491930164 implements MigrationInterface {
  name = 'EnforceLedgerEntriesAppendOnly1785491930164';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION prevent_ledger_entries_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'ledger_entries is append-only — % is not permitted (see docs/architecture.md §7 Data Integrity)', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_entries_append_only
      BEFORE UPDATE OR DELETE ON "ledger_entries"
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_entries_mutation()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "trg_ledger_entries_append_only" ON "ledger_entries"`,
    );
    await queryRunner.query(`DROP FUNCTION prevent_ledger_entries_mutation()`);
  }
}
