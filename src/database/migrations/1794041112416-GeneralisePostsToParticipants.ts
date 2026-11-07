import { MigrationInterface, QueryRunner } from 'typeorm';

export class GeneralisePostsToParticipants1794041112416 implements MigrationInterface {
  name = 'GeneralisePostsToParticipants1794041112416';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "posts" ("id" uuid NOT NULL, "kind" character varying NOT NULL, "author_user_id" uuid NOT NULL, "note" character varying, "visibility" character varying NOT NULL, "requested_visibility" character varying NOT NULL, "is_public" boolean NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_posts_requested_visibility" CHECK ("requested_visibility" IN ('public', 'private')), CONSTRAINT "CHK_posts_visibility" CHECK ("visibility" IN ('public', 'private')), CONSTRAINT "CHK_posts_kind" CHECK ("kind" IN ('transfer')), CONSTRAINT "PK_2829ac61eff60fcec60d7274b9e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "post_participants" ("post_id" uuid NOT NULL, "user_id" uuid NOT NULL, "role" character varying NOT NULL, "hidden" boolean NOT NULL DEFAULT false, "post_created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "post_is_public" boolean NOT NULL, CONSTRAINT "CHK_post_participants_role" CHECK ("role" IN ('author', 'counterparty')), CONSTRAINT "PK_252e366f443adcda70ce2f1bbd1" PRIMARY KEY ("post_id", "user_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_participants" ADD CONSTRAINT "FK_post_participants_post_id" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `INSERT INTO "posts" ("id", "kind", "author_user_id", "note", "visibility", "requested_visibility", "is_public", "created_at", "updated_at")
      SELECT "transaction_id", 'transfer', "sender_user_id", "note", "visibility", "requested_visibility",
        "visibility" = 'public' AND NOT "hidden_by_recipient", "created_at", "updated_at"
      FROM "transaction_posts"`,
    );
    await queryRunner.query(
      `INSERT INTO "post_participants" ("post_id", "user_id", "role", "hidden", "post_created_at", "post_is_public")
      SELECT "id", "author_user_id", 'author', false, "created_at", "is_public" FROM "posts"`,
    );
    await queryRunner.query(
      `INSERT INTO "post_participants" ("post_id", "user_id", "role", "hidden", "post_created_at", "post_is_public")
      SELECT tp."transaction_id", tp."recipient_user_id", 'counterparty', tp."hidden_by_recipient", p."created_at", p."is_public"
      FROM "transaction_posts" tp JOIN "posts" p ON p."id" = tp."transaction_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "post_comments" DROP CONSTRAINT "FK_post_comments_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_reactions" DROP CONSTRAINT "FK_post_reactions_post_id"`,
    );
    // Rewrites post_reactions primary key values, which Postgres allows.
    await queryRunner.query(
      `UPDATE "post_reactions" SET "post_id" = tp."transaction_id" FROM "transaction_posts" tp WHERE "post_id" = tp."id"`,
    );
    await queryRunner.query(
      `UPDATE "post_comments" SET "post_id" = tp."transaction_id" FROM "transaction_posts" tp WHERE "post_id" = tp."id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_comments" ADD CONSTRAINT "FK_post_comments_post_id" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_reactions" ADD CONSTRAINT "FK_post_reactions_post_id" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`DROP TABLE "transaction_posts"`);

    await queryRunner.query(
      `CREATE INDEX "IDX_post_participants_feed" ON "post_participants" ("user_id", "post_created_at" DESC, "post_id" DESC) WHERE "post_is_public"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "transaction_posts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "transaction_id" uuid NOT NULL, "sender_user_id" uuid NOT NULL, "recipient_user_id" uuid NOT NULL, "note" character varying, "visibility" character varying NOT NULL, "requested_visibility" character varying NOT NULL, "hidden_by_recipient" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_transaction_posts_transaction_id" UNIQUE ("transaction_id"), CONSTRAINT "CHK_transaction_posts_visibility" CHECK ("visibility" IN ('public', 'private')), CONSTRAINT "CHK_transaction_posts_requested_visibility" CHECK ("requested_visibility" IN ('public', 'private')), CONSTRAINT "PK_f19563aca8c1f3eff2a81482db2" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transaction_posts_recipient_public" ON "transaction_posts" ("recipient_user_id", "created_at" DESC, "id" DESC) WHERE "visibility" = 'public' AND "hidden_by_recipient" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transaction_posts_sender_public" ON "transaction_posts" ("sender_user_id", "created_at" DESC, "id" DESC) WHERE "visibility" = 'public' AND "hidden_by_recipient" = false`,
    );
    // Each row keeps its transaction id as its own id, so reactions and
    // comments already point at the right row once their foreign keys move.
    await queryRunner.query(
      `INSERT INTO "transaction_posts" ("id", "transaction_id", "sender_user_id", "recipient_user_id", "note", "visibility", "requested_visibility", "hidden_by_recipient", "created_at", "updated_at")
      SELECT p."id", p."id", a."user_id", c."user_id", p."note", p."visibility", p."requested_visibility", c."hidden", p."created_at", p."updated_at"
      FROM "posts" p
      JOIN "post_participants" a ON a."post_id" = p."id" AND a."role" = 'author'
      JOIN "post_participants" c ON c."post_id" = p."id" AND c."role" = 'counterparty'`,
    );

    await queryRunner.query(
      `ALTER TABLE "post_reactions" DROP CONSTRAINT "FK_post_reactions_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_comments" DROP CONSTRAINT "FK_post_comments_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_reactions" ADD CONSTRAINT "FK_post_reactions_post_id" FOREIGN KEY ("post_id") REFERENCES "transaction_posts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "post_comments" ADD CONSTRAINT "FK_post_comments_post_id" FOREIGN KEY ("post_id") REFERENCES "transaction_posts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`DROP INDEX "public"."IDX_post_participants_feed"`);
    await queryRunner.query(
      `ALTER TABLE "post_participants" DROP CONSTRAINT "FK_post_participants_post_id"`,
    );
    await queryRunner.query(`DROP TABLE "post_participants"`);
    await queryRunner.query(`DROP TABLE "posts"`);
  }
}
