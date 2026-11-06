import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTransactionPosts1793865253317 implements MigrationInterface {
  name = 'AddTransactionPosts1793865253317';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "transaction_posts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "transaction_id" uuid NOT NULL, "sender_user_id" uuid NOT NULL, "recipient_user_id" uuid NOT NULL, "note" character varying, "visibility" character varying NOT NULL, "requested_visibility" character varying NOT NULL, "hidden_by_recipient" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_transaction_posts_transaction_id" UNIQUE ("transaction_id"), CONSTRAINT "CHK_transaction_posts_visibility" CHECK ("visibility" IN ('public', 'private')), CONSTRAINT "CHK_transaction_posts_requested_visibility" CHECK ("requested_visibility" IN ('public', 'private')), CONSTRAINT "PK_f19563aca8c1f3eff2a81482db2" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transaction_posts_recipient_public" ON "transaction_posts" ("recipient_user_id", "created_at" DESC, "id" DESC) WHERE "visibility" = 'public' AND "hidden_by_recipient" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transaction_posts_sender_public" ON "transaction_posts" ("sender_user_id", "created_at" DESC, "id" DESC) WHERE "visibility" = 'public' AND "hidden_by_recipient" = false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transaction_posts_sender_public"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_transaction_posts_recipient_public"`,
    );
    await queryRunner.query(`DROP TABLE "transaction_posts"`);
  }
}
