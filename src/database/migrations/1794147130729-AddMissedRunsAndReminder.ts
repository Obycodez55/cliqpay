import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMissedRunsAndReminder1794147130729 implements MigrationInterface {
  name = 'AddMissedRunsAndReminder1794147130729';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD "last_reminded_run_date" date`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ALTER COLUMN "attempt_number" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ALTER COLUMN "reference" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ALTER COLUMN "outcome" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ALTER COLUMN "started_at" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ADD CONSTRAINT "CHK_scheduled_payment_attempts_attempt_fields" CHECK ("kind" <> 'attempt' OR ("attempt_number" IS NOT NULL AND "reference" IS NOT NULL AND "outcome" IS NOT NULL AND "started_at" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" DROP CONSTRAINT "CHK_scheduled_payment_attempts_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ADD CONSTRAINT "CHK_scheduled_payment_attempts_kind" CHECK ("kind" IN ('attempt', 'missed'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" DROP CONSTRAINT "CHK_scheduled_payment_runs_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" ADD CONSTRAINT "CHK_scheduled_payment_runs_status" CHECK ("status" IN ('pending', 'succeeded', 'failed', 'cancelled', 'missed'))`,
    );
  }

  // Fails if a missed run or attempt row exists: attempts are append-only, so
  // those rows can't be removed to make the old shape fit.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" DROP CONSTRAINT "CHK_scheduled_payment_runs_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" ADD CONSTRAINT "CHK_scheduled_payment_runs_status" CHECK ("status" IN ('pending', 'succeeded', 'failed', 'cancelled'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" DROP CONSTRAINT "CHK_scheduled_payment_attempts_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ADD CONSTRAINT "CHK_scheduled_payment_attempts_kind" CHECK ("kind" IN ('attempt'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" DROP CONSTRAINT "CHK_scheduled_payment_attempts_attempt_fields"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ALTER COLUMN "started_at" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ALTER COLUMN "outcome" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ALTER COLUMN "reference" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ALTER COLUMN "attempt_number" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP COLUMN "last_reminded_run_date"`,
    );
  }
}
