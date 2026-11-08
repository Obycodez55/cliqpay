import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBillSplits1794046850838 implements MigrationInterface {
  name = 'AddBillSplits1794046850838';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "bill_splits" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "initiator_user_id" uuid NOT NULL, "reference" character varying NOT NULL, "description" character varying(140) NOT NULL, "mode" character varying NOT NULL, "total_amount" bigint NOT NULL, "initiator_share" bigint NOT NULL, "currency" character varying NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_bill_splits_initiator_user_id_reference" UNIQUE ("initiator_user_id", "reference"), CONSTRAINT "CHK_bill_splits_mode" CHECK ("mode" IN ('equal', 'custom')), CONSTRAINT "PK_26b8fbcea7db05e2c38a516a592" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bill_splits_initiator_user_id_created_at" ON "bill_splits" ("initiator_user_id", "created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE TABLE "bill_split_participants" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "bill_split_id" uuid NOT NULL, "user_id" uuid NOT NULL, "amount" bigint NOT NULL, "money_request_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_bill_split_participants_money_request_id" UNIQUE ("money_request_id"), CONSTRAINT "UQ_bill_split_participants_bill_split_id_user_id" UNIQUE ("bill_split_id", "user_id"), CONSTRAINT "PK_a9aeed3569c1e601515560c2698" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bill_split_participants_user_id_created_at" ON "bill_split_participants" ("user_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `ALTER TABLE "posts" ADD "origin" character varying`,
    );
    await queryRunner.query(
      `UPDATE "posts" SET "origin" = 'money_request' WHERE "id" IN (SELECT "transaction_id" FROM "money_requests" WHERE "transaction_id" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "money_requests" ADD "kind" character varying NOT NULL DEFAULT 'direct'`,
    );
    await queryRunner.query(
      `ALTER TABLE "posts" ADD CONSTRAINT "CHK_posts_origin" CHECK ("origin" IN ('money_request'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "money_requests" ADD CONSTRAINT "CHK_money_requests_kind" CHECK ("kind" IN ('direct', 'group_share'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "bill_split_participants" ADD CONSTRAINT "FK_bill_split_participants_bill_split_id" FOREIGN KEY ("bill_split_id") REFERENCES "bill_splits"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = (await queryRunner.query(
      `SELECT count(*) FROM "money_requests" WHERE "kind" = 'group_share'`,
    )) as { count: string }[];
    if (Number(count) > 0) {
      throw new Error(
        `Cannot revert AddBillSplits: ${count} group_share money request(s) exist, and dropping "kind" would turn them into direct requests`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "bill_split_participants" DROP CONSTRAINT "FK_bill_split_participants_bill_split_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "money_requests" DROP CONSTRAINT "CHK_money_requests_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "posts" DROP CONSTRAINT "CHK_posts_origin"`,
    );
    await queryRunner.query(`ALTER TABLE "money_requests" DROP COLUMN "kind"`);
    await queryRunner.query(`ALTER TABLE "posts" DROP COLUMN "origin"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bill_split_participants_user_id_created_at"`,
    );
    await queryRunner.query(`DROP TABLE "bill_split_participants"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bill_splits_initiator_user_id_created_at"`,
    );
    await queryRunner.query(`DROP TABLE "bill_splits"`);
  }
}
