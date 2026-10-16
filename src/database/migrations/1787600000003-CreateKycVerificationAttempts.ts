import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKycVerificationAttempts1787600000003 implements MigrationInterface {
  name = 'CreateKycVerificationAttempts1787600000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "kyc_verification_attempts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "identity_type" varchar NOT NULL,
        "succeeded" boolean NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_kyc_verification_attempts_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_kyc_verification_attempts_identity_type" CHECK ("identity_type" IN ('bvn', 'nin'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_kyc_verification_attempts_user_identity_created"
        ON "kyc_verification_attempts" ("user_id", "identity_type", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "kyc_verification_attempts"`);
  }
}
