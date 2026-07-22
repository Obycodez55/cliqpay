import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVerificationCodes1784672011426 implements MigrationInterface {
  name = 'CreateVerificationCodes1784672011426';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "verification_codes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "purpose" varchar NOT NULL,
        "code_hash" varchar NOT NULL,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "used_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_verification_codes_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_verification_codes_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
        CONSTRAINT "CHK_verification_codes_purpose" CHECK ("purpose" IN ('email_verification', 'phone_verification', 'password_reset'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_verification_codes_user_id" ON "verification_codes" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_verification_codes_user_id_purpose" ON "verification_codes" ("user_id", "purpose")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_verification_codes_code_hash" ON "verification_codes" ("code_hash")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "verification_codes"`);
  }
}
