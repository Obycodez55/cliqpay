import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSessions1784642459395 implements MigrationInterface {
  name = 'CreateSessions1784642459395';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "current_token_hash" varchar NOT NULL,
        "previous_token_hash" varchar,
        "status" varchar NOT NULL DEFAULT 'active',
        "trusted_device_id" uuid,
        "expires_at" TIMESTAMP NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "last_used_at" TIMESTAMP NOT NULL,
        CONSTRAINT "PK_sessions_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sessions_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
        CONSTRAINT "UQ_sessions_current_token_hash" UNIQUE ("current_token_hash"),
        CONSTRAINT "CHK_sessions_status" CHECK ("status" IN ('active', 'revoked'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_sessions_user_id" ON "sessions" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_sessions_previous_token_hash" ON "sessions" ("previous_token_hash")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "sessions"`);
  }
}
