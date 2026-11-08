import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPostPublishedAt1794071676605 implements MigrationInterface {
  name = 'AddPostPublishedAt1794071676605';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "posts" ADD "published_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`UPDATE "posts" SET "published_at" = "created_at"`);
    await queryRunner.query(
      `ALTER TABLE "posts" DROP CONSTRAINT "CHK_posts_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "posts" ADD CONSTRAINT "CHK_posts_kind" CHECK ("kind" IN ('transfer', 'bill_split'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_participants" DROP CONSTRAINT "CHK_post_participants_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_participants" ADD CONSTRAINT "CHK_post_participants_role" CHECK ("role" IN ('author', 'counterparty', 'member'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = (await queryRunner.query(
      `SELECT count(*) FROM "posts" WHERE "kind" = 'bill_split'`,
    )) as { count: string }[];
    if (Number(count) > 0) {
      throw new Error(
        `Cannot revert AddPostPublishedAt: ${count} bill_split post(s) exist, and removing them would leave their bill splits without a post`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "post_participants" DROP CONSTRAINT "CHK_post_participants_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_participants" ADD CONSTRAINT "CHK_post_participants_role" CHECK ("role" IN ('author', 'counterparty'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "posts" DROP CONSTRAINT "CHK_posts_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "posts" ADD CONSTRAINT "CHK_posts_kind" CHECK ("kind" IN ('transfer'))`,
    );
    await queryRunner.query(`ALTER TABLE "posts" DROP COLUMN "published_at"`);
  }
}
