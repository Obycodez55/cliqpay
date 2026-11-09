import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeviceBinding1794243655692 implements MigrationInterface {
  name = 'AddDeviceBinding1794243655692';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "device_challenges" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "nonce_hash" character varying NOT NULL, "device_id" character varying NOT NULL, "purpose" character varying NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_device_challenges_purpose" CHECK ("purpose" IN ('login', 'refresh', 'register')), CONSTRAINT "PK_69f3a9294759b341604c069ce29" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_device_challenges_nonce_hash" ON "device_challenges"  ("nonce_hash") `,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ADD "device_id" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ADD "public_key" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ADD "attestation_result" character varying NOT NULL DEFAULT 'unavailable'`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ADD "revoked_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD "device_id" character varying`,
    );
    // Cutover: nothing issued before device binding carries a device id, so
    // every existing session and trusted device is revoked and users log in
    // once more.
    await queryRunner.query(
      `UPDATE "sessions" SET "status" = 'revoked', "device_id" = 'pre-binding'`,
    );
    await queryRunner.query(
      `UPDATE "trusted_devices" SET "revoked_at" = now(), "device_id" = 'pre-binding'`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ALTER COLUMN "device_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ALTER COLUMN "device_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_trusted_devices_device_id" ON "trusted_devices"  ("device_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ADD CONSTRAINT "CHK_trusted_devices_attestation_result" CHECK ("attestation_result" IN ('passed', 'failed', 'unavailable'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" DROP CONSTRAINT "CHK_trusted_devices_attestation_result"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_trusted_devices_device_id"`,
    );
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "device_id"`);
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" DROP COLUMN "revoked_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" DROP COLUMN "attestation_result"`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" DROP COLUMN "public_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" DROP COLUMN "device_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_device_challenges_nonce_hash"`,
    );
    await queryRunner.query(`DROP TABLE "device_challenges"`);
  }
}
