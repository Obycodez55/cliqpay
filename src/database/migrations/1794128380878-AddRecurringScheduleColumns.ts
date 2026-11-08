import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRecurringScheduleColumns1794128380878 implements MigrationInterface {
  name = 'AddRecurringScheduleColumns1794128380878';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD "anchor_run_number" integer NOT NULL DEFAULT '1'`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD "interval_unit" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD "interval_count" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD "end_date" date`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD "max_runs" integer`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_payments_user_id_created_at" ON "scheduled_payments" ("user_id", "created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD CONSTRAINT "CHK_scheduled_payments_max_runs" CHECK ("max_runs" IS NULL OR "max_runs" BETWEEN 1 AND 366)`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD CONSTRAINT "CHK_scheduled_payments_end_condition" CHECK ("end_date" IS NULL OR "max_runs" IS NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD CONSTRAINT "CHK_scheduled_payments_interval" CHECK (("interval_unit" IS NULL AND "interval_count" IS NULL) OR ("interval_unit" = 'day' AND "interval_count" IS NOT NULL AND "interval_count" BETWEEN 1 AND 365) OR ("interval_unit" = 'week' AND "interval_count" IS NOT NULL AND "interval_count" BETWEEN 1 AND 52) OR ("interval_unit" = 'month' AND "interval_count" IS NOT NULL AND "interval_count" BETWEEN 1 AND 12))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP CONSTRAINT "CHK_scheduled_payments_interval"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP CONSTRAINT "CHK_scheduled_payments_end_condition"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP CONSTRAINT "CHK_scheduled_payments_max_runs"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_scheduled_payments_user_id_created_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP COLUMN "max_runs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP COLUMN "end_date"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP COLUMN "interval_count"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP COLUMN "interval_unit"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP COLUMN "anchor_run_number"`,
    );
  }
}
