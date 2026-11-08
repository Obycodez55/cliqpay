import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduleAuditIndexes1794161898245 implements MigrationInterface {
  name = 'AddScheduleAuditIndexes1794161898245';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_payment_changes_scheduled_payment_id" ON "scheduled_payment_changes"  ("scheduled_payment_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_payment_runs_updated_at_settling" ON "scheduled_payment_runs"  ("updated_at") WHERE "status" = 'settling'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_scheduled_payment_attempts_run_id_attempt_number" ON "scheduled_payment_attempts"  ("run_id", "attempt_number") WHERE "kind" = 'attempt'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_payment_attempts_run_id" ON "scheduled_payment_attempts"  ("run_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_scheduled_payment_attempts_run_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_scheduled_payment_attempts_run_id_attempt_number"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_scheduled_payment_runs_updated_at_settling"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_scheduled_payment_changes_scheduled_payment_id"`,
    );
  }
}
