import { MigrationInterface, QueryRunner } from 'typeorm';

// `held` / `refunded` are funding statuses, `funding_refund` the type of one
// refund attempt of a held funding (docs/adr/0021). The partial index backs
// the held-funding queries of the refund recovery job.
export class AddHeldFundingStatusesAndRefundType1787700000001 implements MigrationInterface {
  name = 'AddHeldFundingStatusesAndRefundType1787700000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_status"
        CHECK ("status" IN ('pending', 'completed', 'failed', 'reversed', 'disputed', 'held', 'refunded'))
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_type"
        CHECK ("type" IN ('funding', 'funding_refund', 'p2p_transfer', 'withdrawal', 'withdrawal_reversal', 'chargeback', 'chargeback_reversal', 'profit_withdrawal', 'bill_split', 'scheduled'))
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_transactions_held_funding"
        ON "transactions" ("created_at")
        WHERE "type" = 'funding' AND "status" = 'held'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_transactions_held_funding"`);
    await queryRunner.query(`
      ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_type"
        CHECK ("type" IN ('funding', 'p2p_transfer', 'withdrawal', 'withdrawal_reversal', 'chargeback', 'chargeback_reversal', 'profit_withdrawal', 'bill_split', 'scheduled'))
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_status"
        CHECK ("status" IN ('pending', 'completed', 'failed', 'reversed', 'disputed'))
    `);
  }
}
