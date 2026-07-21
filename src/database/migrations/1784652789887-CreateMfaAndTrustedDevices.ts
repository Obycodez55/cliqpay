import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMfaAndTrustedDevices1784652789887 implements MigrationInterface {
  name = 'CreateMfaAndTrustedDevices1784652789887';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mfa_methods" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "type" varchar NOT NULL,
        "status" varchar NOT NULL DEFAULT 'pending',
        "secret_ciphertext" varchar,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mfa_methods_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mfa_methods_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
        CONSTRAINT "UQ_mfa_methods_user_id_type" UNIQUE ("user_id", "type"),
        CONSTRAINT "CHK_mfa_methods_type" CHECK ("type" IN ('email', 'totp')),
        CONSTRAINT "CHK_mfa_methods_status" CHECK ("status" IN ('pending', 'active'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_mfa_methods_user_id" ON "mfa_methods" ("user_id")
    `);

    // No user_id column here — it's derivable via method_id -> mfa_methods.user_id
    // and nothing queries challenges by user directly, so a redundant FK would
    // just be denormalization with no read pattern to justify it.
    await queryRunner.query(`
      CREATE TABLE "mfa_challenges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "method_id" uuid NOT NULL,
        "code_hash" varchar,
        "status" varchar NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "expires_at" TIMESTAMP NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mfa_challenges_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mfa_challenges_method_id" FOREIGN KEY ("method_id") REFERENCES "mfa_methods"("id"),
        CONSTRAINT "CHK_mfa_challenges_status" CHECK ("status" IN ('pending', 'verified', 'failed'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_mfa_challenges_method_id" ON "mfa_challenges" ("method_id")
    `);

    // `device` shape mirrors sessions' below — see ADR-0003: captured once
    // here, at the point trust is issued, rather than kept in sync with
    // whatever the trusting session's own value is. jsonb, not flat
    // ip_address/user_agent columns — see DeviceMetadata (device-metadata.util.ts).
    await queryRunner.query(`
      CREATE TABLE "trusted_devices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "token_hash" varchar NOT NULL,
        "device" jsonb NOT NULL,
        "expires_at" TIMESTAMP NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "last_used_at" TIMESTAMP NOT NULL,
        CONSTRAINT "PK_trusted_devices_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_trusted_devices_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
        CONSTRAINT "UQ_trusted_devices_token_hash" UNIQUE ("token_hash")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_trusted_devices_user_id" ON "trusted_devices" ("user_id")
    `);

    // sessions.trusted_device_id existed as a bare column since CreateSessions
    // (see session.entity.ts) — trusted_devices didn't exist yet, so no FK
    // could be added at the time. Real FK now that its target exists.
    await queryRunner.query(`
      ALTER TABLE "sessions" ADD CONSTRAINT "FK_sessions_trusted_device_id" FOREIGN KEY ("trusted_device_id") REFERENCES "trusted_devices"("id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_sessions_trusted_device_id" ON "sessions" ("trusted_device_id")
    `);

    // Deferred from CreateSessions (issue #3) into this issue on purpose — see
    // ADR-0003: deciding this alongside trusted_devices' own `device` column
    // keeps both device-context captures the same shape.
    await queryRunner.query(`
      ALTER TABLE "sessions" ADD COLUMN "device" jsonb NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      ALTER TABLE "sessions" ALTER COLUMN "device" DROP DEFAULT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sessions" DROP COLUMN "device"
    `);
    await queryRunner.query(`DROP INDEX "IDX_sessions_trusted_device_id"`);
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP CONSTRAINT "FK_sessions_trusted_device_id"`,
    );
    await queryRunner.query(`DROP TABLE "trusted_devices"`);
    await queryRunner.query(`DROP TABLE "mfa_challenges"`);
    await queryRunner.query(`DROP TABLE "mfa_methods"`);
  }
}
