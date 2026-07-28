import { MigrationInterface, QueryRunner } from 'typeorm';

// Nullable — holds the new address between change-email's step-up +
// verification-code send and its confirm, never the live `email` until
// confirm succeeds (see issue #9 / ADR-0006).
export class AddPendingEmailToUsers1784707276064 implements MigrationInterface {
  name = 'AddPendingEmailToUsers1784707276064';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN "pending_email" VARCHAR
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "pending_email"
    `);
  }
}
