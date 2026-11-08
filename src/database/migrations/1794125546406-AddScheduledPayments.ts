import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduledPayments1794125546406 implements MigrationInterface {
  name = 'AddScheduledPayments1794125546406';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "scheduled_payments" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "reference" character varying NOT NULL, "target_type" character varying NOT NULL, "recipient_user_id" uuid NOT NULL, "amount" bigint NOT NULL, "currency" character varying NOT NULL, "note" character varying(500), "visibility" character varying NOT NULL, "start_date" date NOT NULL, "run_offset_minutes" integer NOT NULL, "status" character varying NOT NULL, "next_run_number" integer NOT NULL DEFAULT '1', "next_run_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_scheduled_payments_user_id_reference" UNIQUE ("user_id", "reference"), CONSTRAINT "CHK_scheduled_payments_visibility" CHECK ("visibility" IN ('public', 'private')), CONSTRAINT "CHK_scheduled_payments_status" CHECK ("status" IN ('active', 'cancelled', 'completed')), CONSTRAINT "CHK_scheduled_payments_target_type" CHECK ("target_type" IN ('user')), CONSTRAINT "PK_2e4f2560e1a39fae948cda9fdd8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_payments_next_run_at" ON "scheduled_payments"  ("next_run_at") WHERE "status" = 'active'`,
    );
    await queryRunner.query(
      `CREATE TABLE "scheduled_payment_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "scheduled_payment_id" uuid NOT NULL, "run_number" integer NOT NULL, "due_at" TIMESTAMP WITH TIME ZONE NOT NULL, "status" character varying NOT NULL, "amount" bigint NOT NULL, "target_type" character varying NOT NULL, "recipient_user_id" uuid NOT NULL, "note" character varying(500), "visibility" character varying NOT NULL, "attempt_count" integer NOT NULL DEFAULT '0', "transaction_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_scheduled_payment_runs_scheduled_payment_id_run_number" UNIQUE ("scheduled_payment_id", "run_number"), CONSTRAINT "CHK_scheduled_payment_runs_visibility" CHECK ("visibility" IN ('public', 'private')), CONSTRAINT "CHK_scheduled_payment_runs_target_type" CHECK ("target_type" IN ('user')), CONSTRAINT "CHK_scheduled_payment_runs_status" CHECK ("status" IN ('pending', 'succeeded', 'failed', 'cancelled')), CONSTRAINT "PK_e29e44080be9a799e89eba8cf4c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "scheduled_payment_attempts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "run_id" uuid NOT NULL, "kind" character varying NOT NULL, "attempt_number" integer NOT NULL, "reference" character varying NOT NULL, "outcome" character varying NOT NULL, "failure_code" character varying, "transaction_id" uuid, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_scheduled_payment_attempts_failure_code" CHECK ("failure_code" IS NULL OR "failure_code" IN ('insufficient_balance', 'daily_limit_exceeded', 'recipient_cap', 'blocked', 'recipient_unavailable', 'sender_frozen', 'infrastructure')), CONSTRAINT "CHK_scheduled_payment_attempts_outcome" CHECK ("outcome" IN ('succeeded', 'failed')), CONSTRAINT "CHK_scheduled_payment_attempts_kind" CHECK ("kind" IN ('attempt')), CONSTRAINT "PK_e8508409b7d187164d03a8c937d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "scheduled_payment_changes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "scheduled_payment_id" uuid NOT NULL, "kind" character varying NOT NULL, "actor" character varying NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_scheduled_payment_changes_actor" CHECK ("actor" IN ('user', 'system')), CONSTRAINT "CHK_scheduled_payment_changes_kind" CHECK ("kind" IN ('created', 'cancelled', 'completed')), CONSTRAINT "PK_005fc9bc889d1b272dbc16f8ccf" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" ADD CONSTRAINT "FK_scheduled_payment_runs_scheduled_payment_id" FOREIGN KEY ("scheduled_payment_id") REFERENCES "scheduled_payments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ADD CONSTRAINT "FK_scheduled_payment_attempts_run_id" FOREIGN KEY ("run_id") REFERENCES "scheduled_payment_runs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" ADD CONSTRAINT "FK_scheduled_payment_changes_scheduled_payment_id" FOREIGN KEY ("scheduled_payment_id") REFERENCES "scheduled_payments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`
      CREATE FUNCTION prevent_scheduled_payment_audit_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only — % is not permitted (see ADR-0028)', TG_TABLE_NAME, TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of [
      'scheduled_payment_attempts',
      'scheduled_payment_changes',
    ]) {
      await queryRunner.query(`
        CREATE TRIGGER "trg_${table}_append_only"
        BEFORE UPDATE OR DELETE ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION prevent_scheduled_payment_audit_mutation()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'scheduled_payment_changes',
      'scheduled_payment_attempts',
    ]) {
      await queryRunner.query(
        `DROP TRIGGER "trg_${table}_append_only" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP FUNCTION prevent_scheduled_payment_audit_mutation()`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_changes" DROP CONSTRAINT "FK_scheduled_payment_changes_scheduled_payment_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" DROP CONSTRAINT "FK_scheduled_payment_attempts_run_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_runs" DROP CONSTRAINT "FK_scheduled_payment_runs_scheduled_payment_id"`,
    );
    await queryRunner.query(`DROP TABLE "scheduled_payment_changes"`);
    await queryRunner.query(`DROP TABLE "scheduled_payment_attempts"`);
    await queryRunner.query(`DROP TABLE "scheduled_payment_runs"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_scheduled_payments_next_run_at"`,
    );
    await queryRunner.query(`DROP TABLE "scheduled_payments"`);
  }
}
