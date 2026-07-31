import { MigrationInterface, QueryRunner } from 'typeorm';

// Two hot queries landed without the indexes they need (Phase 2 audit,
// issues #14/#16): LedgerService.getTransactionHistory filters
// ledger_entries.account_id and orders by (created_at DESC, id DESC), and
// LedgerService.findStaleFundingTransactions filters transactions on
// status/provider/type/created_at every 5 minutes. Without these,
// transaction history sorts a user's whole entry set per page, and the
// poll job seq-scans all of `transactions` on a schedule, forever.
export class AddFundingQueryIndexes1785488695081 implements MigrationInterface {
  name = 'AddFundingQueryIndexes1785488695081';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "IDX_ledger_entries_account_id_created_at_id"
      ON "ledger_entries" ("account_id", "created_at" DESC, "id" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_transactions_stale_funding_poll"
      ON "transactions" ("status", "provider", "type", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_transactions_stale_funding_poll"`);
    await queryRunner.query(
      `DROP INDEX "IDX_ledger_entries_account_id_created_at_id"`,
    );
  }
}
