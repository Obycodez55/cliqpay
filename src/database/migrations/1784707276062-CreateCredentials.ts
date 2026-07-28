import { MigrationInterface, QueryRunner } from 'typeorm';

// Splits auth's IAM mechanics (password/PIN/lockout) off of `users` (see
// ADR-0005) — `user_id` carries no FK since `credentials` is `auth`-owned
// and `users` is a separate core module (cross-module reference, per
// ADR-0002). Unique on `user_id` enforces the 1:1 cardinality locally,
// without needing a real FK to do it.
export class CreateCredentials1784707276062 implements MigrationInterface {
  name = 'CreateCredentials1784707276062';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "credentials" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "password_hash" varchar NOT NULL,
        "transaction_pin_hash" varchar,
        "failed_login_attempts" integer NOT NULL DEFAULT 0,
        "locked_until" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credentials_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_credentials_user_id" UNIQUE ("user_id")
      )
    `);

    // Carries each row's own created_at/updated_at forward from `users`
    // rather than stamping now() — password_hash's real creation time is
    // registration time, not migration time.
    await queryRunner.query(`
      INSERT INTO "credentials"
        ("user_id", "password_hash", "transaction_pin_hash",
         "failed_login_attempts", "locked_until", "created_at", "updated_at")
      SELECT
        "id", "password_hash", "transaction_pin_hash",
        "failed_login_attempts", "locked_until", "created_at", "updated_at"
      FROM "users"
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN "password_hash",
        DROP COLUMN "transaction_pin_hash",
        DROP COLUMN "failed_login_attempts",
        DROP COLUMN "locked_until"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "password_hash" varchar,
        ADD COLUMN "transaction_pin_hash" varchar,
        ADD COLUMN "failed_login_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN "locked_until" TIMESTAMPTZ
    `);

    await queryRunner.query(`
      UPDATE "users" u SET
        "password_hash" = c."password_hash",
        "transaction_pin_hash" = c."transaction_pin_hash",
        "failed_login_attempts" = c."failed_login_attempts",
        "locked_until" = c."locked_until"
      FROM "credentials" c
      WHERE c."user_id" = u."id"
    `);

    await queryRunner.query(`
      ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL
    `);

    await queryRunner.query(`DROP TABLE "credentials"`);
  }
}
