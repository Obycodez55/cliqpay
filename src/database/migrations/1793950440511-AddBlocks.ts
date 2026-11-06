import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBlocks1793950440511 implements MigrationInterface {
  name = 'AddBlocks1793950440511';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "blocks" ("blocker_user_id" uuid NOT NULL, "blocked_user_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_blocks_not_self" CHECK ("blocker_user_id" <> "blocked_user_id"), CONSTRAINT "PK_5f5a0f1a4e96094919dfa863225" PRIMARY KEY ("blocker_user_id", "blocked_user_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_blocks_blocker_created" ON "blocks"  ("blocker_user_id", "created_at", "blocked_user_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_blocks_blocker_created"`);
    await queryRunner.query(`DROP TABLE "blocks"`);
  }
}
