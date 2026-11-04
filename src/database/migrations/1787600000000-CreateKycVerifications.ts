import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKycVerifications1787600000000 implements MigrationInterface {
  name = 'CreateKycVerifications1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "kyc_verifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "bvn_ciphertext" varchar,
        "bvn_hash" varchar,
        "nin_ciphertext" varchar,
        "nin_hash" varchar,
        "address" jsonb,
        "identity" jsonb,
        "verified_legal_name" varchar,
        "liveness_verified" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_kyc_verifications_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_kyc_verifications_user_id" UNIQUE ("user_id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_kyc_verifications_bvn_hash_partial"
        ON "kyc_verifications" ("bvn_hash")
        WHERE "bvn_hash" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_kyc_verifications_nin_hash_partial"
        ON "kyc_verifications" ("nin_hash")
        WHERE "nin_hash" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "kyc_verifications"`);
  }
}
