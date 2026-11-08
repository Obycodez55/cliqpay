import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduledPaymentUpdates1794148821667 implements MigrationInterface {
  name = 'AddScheduledPaymentUpdates1794148821667';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" ADD "changes" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" DROP CONSTRAINT "CHK_scheduled_payment_changes_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" ADD CONSTRAINT "CHK_scheduled_payment_changes_kind" CHECK ("kind" IN ('created', 'paused', 'resumed', 'updated', 'cancelled', 'completed'))`,
    );
  }

  // Fails if an `updated` change row exists: the table is append-only, so
  // those rows can't be removed to make the old shape fit.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" DROP CONSTRAINT "CHK_scheduled_payment_changes_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" ADD CONSTRAINT "CHK_scheduled_payment_changes_kind" CHECK ("kind" IN ('created', 'paused', 'resumed', 'cancelled', 'completed'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" DROP COLUMN "changes"`,
    );
  }
}
