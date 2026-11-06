import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPostComments1793954401049 implements MigrationInterface {
  name = 'AddPostComments1793954401049';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "post_comments" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "post_id" uuid NOT NULL, "author_user_id" uuid NOT NULL, "body" character varying(280) NOT NULL, "deleted_at" TIMESTAMP WITH TIME ZONE, "deleted_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_2e99e04b4a1b31de6f833c18ced" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_post_comments_post_live" ON "post_comments"  ("post_id", "created_at", "id") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_comments" ADD CONSTRAINT "FK_post_comments_post_id" FOREIGN KEY ("post_id") REFERENCES "transaction_posts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "post_comments" DROP CONSTRAINT "FK_post_comments_post_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_post_comments_post_live"`,
    );
    await queryRunner.query(`DROP TABLE "post_comments"`);
  }
}
