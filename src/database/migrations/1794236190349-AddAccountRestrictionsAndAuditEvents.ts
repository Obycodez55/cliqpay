import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAccountRestrictionsAndAuditEvents1794236190349 implements MigrationInterface {
  name = 'AddAccountRestrictionsAndAuditEvents1794236190349';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "account_restrictions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "reason" character varying NOT NULL, "scope" character varying NOT NULL, "source_id" uuid NOT NULL, "note" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lifted_at" TIMESTAMP WITH TIME ZONE, "lifted_by" character varying, CONSTRAINT "CHK_account_restrictions_scope" CHECK ("scope" IN ('outbound', 'all')), CONSTRAINT "CHK_account_restrictions_reason" CHECK ("reason" IN ('dispute', 'fraud', 'self_lock', 'watchlist', 'sanctions')), CONSTRAINT "PK_9a778189d3e963e1be4684f3047" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_restrictions_open_user" ON "account_restrictions"  ("user_id") WHERE "lifted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_account_restrictions_open" ON "account_restrictions"  ("user_id", "reason", "source_id") WHERE "lifted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_events" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "actor_type" character varying NOT NULL, "actor_id" character varying, "action" character varying NOT NULL, "subject_type" character varying NOT NULL, "subject_id" character varying NOT NULL, "metadata" jsonb, "request_id" character varying, CONSTRAINT "CHK_audit_events_actor_type" CHECK ("actor_type" IN ('user', 'reviewer', 'system')), CONSTRAINT "PK_910f64d901a5c3e9878f0d4a407" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_events_subject" ON "audit_events"  ("subject_type", "subject_id", "occurred_at") `,
    );
    await queryRunner.query(`
      INSERT INTO "account_restrictions" ("user_id", "reason", "scope", "source_id", "note")
      SELECT a."user_id", 'dispute', 'outbound', d."id", 'migrated from users.is_frozen'
      FROM "users" u
      JOIN "accounts" a ON a."user_id" = u."id"
      JOIN "transactions" t ON t."sender_wallet_id" = a."id" AND t."type" = 'chargeback'
      JOIN "disputes" d ON d."chargeback_transaction_id" = t."id"
      WHERE u."is_frozen"
    `);
    await queryRunner.query(`
      INSERT INTO "account_restrictions" ("user_id", "reason", "scope", "source_id", "note")
      SELECT u."id", 'dispute', 'outbound', u."id", 'migrated from users.is_frozen'
      FROM "users" u
      WHERE u."is_frozen"
        AND NOT EXISTS (
          SELECT 1 FROM "account_restrictions" r WHERE r."user_id" = u."id"
        )
    `);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "is_frozen"`);
    await queryRunner.query(`
      CREATE FUNCTION prevent_audit_events_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'audit_events is append-only — % is not permitted', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_audit_events_append_only"
      BEFORE UPDATE OR DELETE ON "audit_events"
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_events_mutation()
    `);
    await queryRunner.query(
      `ALTER TABLE "account_restrictions" ADD CONSTRAINT "FK_account_restrictions_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "trg_audit_events_append_only" ON "audit_events"`,
    );
    await queryRunner.query(`DROP FUNCTION prevent_audit_events_mutation()`);
    await queryRunner.query(
      `ALTER TABLE "account_restrictions" DROP CONSTRAINT "FK_account_restrictions_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "is_frozen" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`
      UPDATE "users" SET "is_frozen" = true
      WHERE "id" IN (
        SELECT "user_id" FROM "account_restrictions" WHERE "lifted_at" IS NULL
      )
    `);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_events_subject"`);
    await queryRunner.query(`DROP TABLE "audit_events"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_account_restrictions_open"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_account_restrictions_open_user"`,
    );
    await queryRunner.query(`DROP TABLE "account_restrictions"`);
  }
}
