import { MigrationInterface, QueryRunner } from 'typeorm';
import { seedSystemAccounts } from '../seed-system-accounts';

export class CreateUsersAndAccounts1784628665852 implements MigrationInterface {
  name = 'CreateUsersAndAccounts1784628665852';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" varchar NOT NULL,
        "password_hash" varchar NOT NULL,
        "first_name" varchar NOT NULL,
        "last_name" varchar NOT NULL,
        "username" varchar NOT NULL,
        "phone" varchar NOT NULL,
        "transaction_pin_hash" varchar,
        "email_verified_at" TIMESTAMP,
        "phone_verified_at" TIMESTAMP,
        "failed_login_attempts" integer NOT NULL DEFAULT 0,
        "locked_until" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "UQ_users_username" UNIQUE ("username"),
        CONSTRAINT "UQ_users_phone" UNIQUE ("phone")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "accounts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid,
        "type" varchar NOT NULL,
        "role" varchar NOT NULL,
        "provider" varchar,
        "currency" varchar NOT NULL,
        "balance" bigint NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_accounts_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_accounts_type" CHECK ("type" IN ('asset', 'liability', 'equity', 'expense')),
        CONSTRAINT "CHK_accounts_role" CHECK ("role" IN ('float', 'fee_income', 'fee_expense', 'fee_recovery', 'user_wallet')),
        CONSTRAINT "CHK_accounts_provider" CHECK ("provider" IN ('kora'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_accounts_user_id" ON "accounts" ("user_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_accounts_user_wallet" ON "accounts" ("user_id", "currency") WHERE "role" = 'user_wallet'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_accounts_system" ON "accounts" ("role", "provider", "currency") NULLS NOT DISTINCT WHERE "user_id" IS NULL
    `);

    await seedSystemAccounts(queryRunner, 'NGN');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "accounts"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
