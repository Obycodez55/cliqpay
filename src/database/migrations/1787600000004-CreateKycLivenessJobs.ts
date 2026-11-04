import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKycLivenessJobs1787600000004 implements MigrationInterface {
  name = 'CreateKycLivenessJobs1787600000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "kyc_liveness_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "attempt_id" uuid NOT NULL,
        "identity_type" varchar NOT NULL,
        "provider_job_id" varchar,
        "poll_failures" integer NOT NULL DEFAULT 0,
        "status" varchar NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_kyc_liveness_jobs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_kyc_liveness_jobs_attempt_id" FOREIGN KEY ("attempt_id")
          REFERENCES "kyc_verification_attempts" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_kyc_liveness_jobs_identity_type" CHECK ("identity_type" IN ('bvn', 'nin')),
        CONSTRAINT "CHK_kyc_liveness_jobs_status" CHECK ("status" IN ('pending', 'passed', 'failed'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_kyc_liveness_jobs_user_pending"
        ON "kyc_liveness_jobs" ("user_id") WHERE "status" = 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_kyc_liveness_jobs_provider_job_id"
        ON "kyc_liveness_jobs" ("provider_job_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "kyc_liveness_jobs"`);
  }
}
