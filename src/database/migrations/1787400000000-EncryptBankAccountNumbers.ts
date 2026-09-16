import { MigrationInterface, QueryRunner } from 'typeorm';

// docs/architecture.md §7 requires bank account numbers encrypted at rest —
// `account_number` was left plaintext when CreateBankAccounts1787200000000
// created the table. No production data yet, so this drops and recreates
// the column rather than migrating existing values (see e.g.
// ConvertUsersAndAccountsTimestamps1784707276057 for the same convention).
// The old uniqueness constraint can no longer target the plaintext number —
// `account_number_hash` (a deterministic HMAC, computed application-side)
// takes over that role; see BankAccount entity.
export class EncryptBankAccountNumbers1787400000000 implements MigrationInterface {
  name = 'EncryptBankAccountNumbers1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bank_accounts"
        DROP CONSTRAINT "UQ_bank_accounts_user_provider_bank_account",
        DROP COLUMN "account_number",
        ADD COLUMN "account_number_ciphertext" varchar NOT NULL,
        ADD COLUMN "account_number_hash" varchar NOT NULL,
        ADD CONSTRAINT "UQ_bank_accounts_user_provider_bank_account_hash"
          UNIQUE ("user_id", "provider", "bank_code", "account_number_hash")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bank_accounts"
        DROP CONSTRAINT "UQ_bank_accounts_user_provider_bank_account_hash",
        DROP COLUMN "account_number_hash",
        DROP COLUMN "account_number_ciphertext",
        ADD COLUMN "account_number" varchar NOT NULL,
        ADD CONSTRAINT "UQ_bank_accounts_user_provider_bank_account"
          UNIQUE ("user_id", "provider", "bank_code", "account_number")
    `);
  }
}
