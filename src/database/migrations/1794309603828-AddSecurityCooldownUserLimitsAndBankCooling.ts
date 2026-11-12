import { MigrationInterface, QueryRunner } from 'typeorm';

const BASE_CODES = `'insufficient_balance', 'daily_limit_exceeded', 'recipient_cap', 'blocked', 'recipient_unavailable', 'sender_frozen', 'bank_account_removed', 'payout_rejected', 'amount_below_minimum', 'sender_unverified'`;
const WITH_NEW_CODES = `${BASE_CODES}, 'security_cooldown_limit', 'bank_account_cooling', 'infrastructure'`;
const WITHOUT_NEW_CODES = `${BASE_CODES}, 'infrastructure'`;

export class AddSecurityCooldownUserLimitsAndBankCooling1794309603828 implements MigrationInterface {
  name = 'AddSecurityCooldownUserLimitsAndBankCooling1794309603828';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_limits" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "daily_outflow_limit_minor" bigint, "pending_daily_outflow_limit_minor" bigint, "pending_effective_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_user_limits_user_id" UNIQUE ("user_id"), CONSTRAINT "CHK_user_limits_pending_pair" CHECK (("pending_daily_outflow_limit_minor" IS NULL) = ("pending_effective_at" IS NULL)), CONSTRAINT "CHK_user_limits_amounts_non_negative" CHECK (("daily_outflow_limit_minor" IS NULL OR "daily_outflow_limit_minor" >= 0) AND ("pending_daily_outflow_limit_minor" IS NULL OR "pending_daily_outflow_limit_minor" >= 0)), CONSTRAINT "PK_6ccf7f1003a588cc764f969bd3f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "tier1_reached_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "security_cooldown_until" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "security_cooldown_started_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "bank_accounts" ADD "fully_eligible_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Accounts saved before the cooling rule are fully eligible; existing
    // verified users are not new accounts.
    await queryRunner.query(
      `UPDATE "bank_accounts" SET "fully_eligible_at" = "created_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bank_accounts" ALTER COLUMN "fully_eligible_at" SET NOT NULL`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "tier1_reached_at" = "created_at" WHERE "kyc_tier" <> 'tier0'`,
    );
    await this.replaceFailureCodeCheck(queryRunner, WITH_NEW_CODES);
    await queryRunner.query(
      `CREATE INDEX "IDX_transactions_recipient_wallet_created_at" ON "transactions" ("recipient_wallet_id", "created_at") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transactions_recipient_wallet_created_at"`,
    );
    await this.replaceFailureCodeCheck(queryRunner, WITHOUT_NEW_CODES);
    await queryRunner.query(
      `ALTER TABLE "bank_accounts" DROP COLUMN "fully_eligible_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "security_cooldown_started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "security_cooldown_until"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "tier1_reached_at"`,
    );
    await queryRunner.query(`DROP TABLE "user_limits"`);
  }

  private async replaceFailureCodeCheck(
    queryRunner: QueryRunner,
    codes: string,
  ): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" DROP CONSTRAINT "CHK_scheduled_payment_attempts_failure_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ADD CONSTRAINT "CHK_scheduled_payment_attempts_failure_code" CHECK ("failure_code" IS NULL OR "failure_code" IN (${codes}))`,
    );
  }
}
