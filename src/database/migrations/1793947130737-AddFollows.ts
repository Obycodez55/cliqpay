import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFollows1793947130737 implements MigrationInterface {
  name = 'AddFollows1793947130737';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "follows" ("follower_user_id" uuid NOT NULL, "followee_user_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_follows_not_self" CHECK ("follower_user_id" <> "followee_user_id"), CONSTRAINT "PK_8c92202ca1a0d4bb08ef1c9807d" PRIMARY KEY ("follower_user_id", "followee_user_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_follows_followee_created" ON "follows"  ("followee_user_id", "created_at", "follower_user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_follows_follower_created" ON "follows"  ("follower_user_id", "created_at", "followee_user_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_follows_follower_created"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_follows_followee_created"`,
    );
    await queryRunner.query(`DROP TABLE "follows"`);
  }
}
