import { MigrationInterface, QueryRunner } from 'typeorm';

// Nullable — holds the new number between change-phone's step-up +
// verification-code send and its confirm, never the live `phone` until
// confirm succeeds (see issue #10, mirroring pending_email from issue #9).
export class AddPendingPhoneToUsers1784707276065 implements MigrationInterface {
  name = 'AddPendingPhoneToUsers1784707276065';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN "pending_phone" VARCHAR
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "pending_phone"
    `);
  }
}
