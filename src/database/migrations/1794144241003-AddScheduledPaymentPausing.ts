import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduledPaymentPausing1794144241003 implements MigrationInterface {
  name = 'AddScheduledPaymentPausing1794144241003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD "consecutive_failures" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD "paused_reason" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" ADD "next_attempt_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" ADD "reason" character varying`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_payment_runs_next_attempt_at" ON "scheduled_payment_runs"  ("next_attempt_at") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP CONSTRAINT "CHK_scheduled_payments_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD CONSTRAINT "CHK_scheduled_payments_status" CHECK ("status" IN ('active', 'paused', 'cancelled', 'completed'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" DROP CONSTRAINT "CHK_scheduled_payment_changes_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" ADD CONSTRAINT "CHK_scheduled_payment_changes_kind" CHECK ("kind" IN ('created', 'paused', 'resumed', 'cancelled', 'completed'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" DROP CONSTRAINT "CHK_scheduled_payment_changes_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" ADD CONSTRAINT "CHK_scheduled_payment_changes_kind" CHECK ("kind" IN ('created', 'cancelled', 'completed'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP CONSTRAINT "CHK_scheduled_payments_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD CONSTRAINT "CHK_scheduled_payments_status" CHECK ("status" IN ('active', 'cancelled', 'completed'))`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_scheduled_payment_runs_next_attempt_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" DROP COLUMN "reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" DROP COLUMN "next_attempt_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP COLUMN "paused_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP COLUMN "consecutive_failures"`,
    );
  }
}
