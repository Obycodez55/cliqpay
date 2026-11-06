import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPostReactions1793953420780 implements MigrationInterface {
  name = 'AddPostReactions1793953420780';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "post_reactions" ("post_id" uuid NOT NULL, "user_id" uuid NOT NULL, "reaction" character varying NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_post_reactions_reaction" CHECK ("reaction" IN ('heart', 'laugh', 'wow', 'fire', 'clap', 'pray')), CONSTRAINT "PK_9f396c526942d247ed054f88de9" PRIMARY KEY ("post_id", "user_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_reactions" ADD CONSTRAINT "FK_post_reactions_post_id" FOREIGN KEY ("post_id") REFERENCES "transaction_posts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "post_reactions" DROP CONSTRAINT "FK_post_reactions_post_id"`,
    );
    await queryRunner.query(`DROP TABLE "post_reactions"`);
  }
}
