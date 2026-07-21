import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePushTokens1784616220824 implements MigrationInterface {
  name = 'CreatePushTokens1784616220824';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "push_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "platform" varchar NOT NULL,
        "token" varchar NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "last_used_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_push_tokens_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_push_tokens_token" UNIQUE ("token"),
        CONSTRAINT "CHK_push_tokens_platform" CHECK ("platform" IN ('ios', 'android'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_push_tokens_user_id" ON "push_tokens" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "push_tokens"`);
  }
}
