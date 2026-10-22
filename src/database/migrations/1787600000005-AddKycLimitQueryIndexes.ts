import { MigrationInterface, QueryRunner } from 'typeorm';

// The daily-limit and balance-cap checks run these under the per-user advisory
// lock, so they must not seq-scan `transactions`. Plain CREATE INDEX, not
// CONCURRENTLY: migrations run inside a transaction here.
export class AddKycLimitQueryIndexes1787600000005 implements MigrationInterface {
  name = 'AddKycLimitQueryIndexes1787600000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "IDX_transactions_sender_wallet_created_at"
      ON "transactions" ("sender_wallet_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_transactions_pending_funding_recipient"
      ON "transactions" ("recipient_wallet_id")
      WHERE "type" = 'funding' AND "status" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_transactions_pending_funding_recipient"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_transactions_sender_wallet_created_at"`,
    );
  }
}
