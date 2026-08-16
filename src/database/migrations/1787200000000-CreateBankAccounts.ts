import { MigrationInterface, QueryRunner } from 'typeorm';

// See docs/architecture.md §5 and ADR-0014. `user_id` is a cross-module
// reference into `users` — no FK, same as every other cross-module
// reference (ADR-0002). `account_name` is never client-supplied — it's
// always the value KoraAdapter.resolveBankAccount() returned at save time.
export class CreateBankAccounts1787200000000 implements MigrationInterface {
  name = 'CreateBankAccounts1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "bank_accounts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "provider" varchar NOT NULL,
        "bank_code" varchar NOT NULL,
        "bank_name" varchar NOT NULL,
        "account_number" varchar NOT NULL,
        "account_name" varchar NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_bank_accounts_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_bank_accounts_provider" CHECK ("provider" IN ('kora')),
        CONSTRAINT "UQ_bank_accounts_user_provider_bank_account" UNIQUE ("user_id", "provider", "bank_code", "account_number")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "bank_accounts"`);
  }
}
