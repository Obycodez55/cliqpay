import { MigrationInterface, QueryRunner } from 'typeorm';

const TARGET_CHECK = `("target_type" = 'user' AND "recipient_user_id" IS NOT NULL AND "bank_account_id" IS NULL AND "visibility" IS NOT NULL) OR ("target_type" = 'bank_account' AND "bank_account_id" IS NOT NULL AND "recipient_user_id" IS NULL AND "visibility" IS NULL)`;

export class AddBankAccountScheduleTargets1794155000000 implements MigrationInterface {
  name = 'AddBankAccountScheduleTargets1794155000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['scheduled_payments', 'scheduled_payment_runs']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD "bank_account_id" uuid`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "recipient_user_id" DROP NOT NULL`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "visibility" DROP NOT NULL`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP CONSTRAINT "CHK_scheduled_payments_target_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD CONSTRAINT "CHK_scheduled_payments_target_type" CHECK ("target_type" IN ('user', 'bank_account'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD CONSTRAINT "CHK_scheduled_payments_target" CHECK (${TARGET_CHECK})`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" DROP CONSTRAINT "CHK_scheduled_payment_runs_target_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" ADD CONSTRAINT "CHK_scheduled_payment_runs_target_type" CHECK ("target_type" IN ('user', 'bank_account'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" ADD CONSTRAINT "CHK_scheduled_payment_runs_target" CHECK (${TARGET_CHECK})`,
    );
    await this.replaceCheck(
      queryRunner,
      'scheduled_payment_runs',
      'CHK_scheduled_payment_runs_status',
      `"status" IN ('pending', 'succeeded', 'failed', 'cancelled', 'missed', 'settling', 'reversed')`,
    );
    await this.replaceCheck(
      queryRunner,
      'scheduled_payment_attempts',
      'CHK_scheduled_payment_attempts_kind',
      `"kind" IN ('attempt', 'missed', 'settled', 'reversed')`,
    );
    await this.replaceCheck(
      queryRunner,
      'scheduled_payment_attempts',
      'CHK_scheduled_payment_attempts_outcome',
      `"outcome" IN ('succeeded', 'failed', 'settling')`,
    );
    await this.replaceCheck(
      queryRunner,
      'scheduled_payment_attempts',
      'CHK_scheduled_payment_attempts_failure_code',
      `"failure_code" IS NULL OR "failure_code" IN ('insufficient_balance', 'daily_limit_exceeded', 'recipient_cap', 'blocked', 'recipient_unavailable', 'sender_frozen', 'bank_account_removed', 'payout_rejected', 'infrastructure')`,
    );
  }

  // Fails if a bank-account schedule or run, or a settling, reversed,
  // settled or bank-failure row exists: the attempts table is append-only, so
  // those rows can't be removed to make the old shape fit.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.replaceCheck(
      queryRunner,
      'scheduled_payment_attempts',
      'CHK_scheduled_payment_attempts_failure_code',
      `"failure_code" IS NULL OR "failure_code" IN ('insufficient_balance', 'daily_limit_exceeded', 'recipient_cap', 'blocked', 'recipient_unavailable', 'sender_frozen', 'infrastructure')`,
    );
    await this.replaceCheck(
      queryRunner,
      'scheduled_payment_attempts',
      'CHK_scheduled_payment_attempts_outcome',
      `"outcome" IN ('succeeded', 'failed')`,
    );
    await this.replaceCheck(
      queryRunner,
      'scheduled_payment_attempts',
      'CHK_scheduled_payment_attempts_kind',
      `"kind" IN ('attempt', 'missed')`,
    );
    await this.replaceCheck(
      queryRunner,
      'scheduled_payment_runs',
      'CHK_scheduled_payment_runs_status',
      `"status" IN ('pending', 'succeeded', 'failed', 'cancelled', 'missed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" DROP CONSTRAINT "CHK_scheduled_payment_runs_target"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" DROP CONSTRAINT "CHK_scheduled_payment_runs_target_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" ADD CONSTRAINT "CHK_scheduled_payment_runs_target_type" CHECK ("target_type" IN ('user'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP CONSTRAINT "CHK_scheduled_payments_target"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP CONSTRAINT "CHK_scheduled_payments_target_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD CONSTRAINT "CHK_scheduled_payments_target_type" CHECK ("target_type" IN ('user'))`,
    );
    for (const table of ['scheduled_payment_runs', 'scheduled_payments']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "visibility" SET NOT NULL`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "recipient_user_id" SET NOT NULL`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN "bank_account_id"`,
      );
    }
  }

  private async replaceCheck(
    queryRunner: QueryRunner,
    table: string,
    name: string,
    expression: string,
  ): Promise<void> {
    await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`);
    await queryRunner.query(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expression})`,
    );
  }
}
