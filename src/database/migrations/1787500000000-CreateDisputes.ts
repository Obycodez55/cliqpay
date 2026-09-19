import { MigrationInterface, QueryRunner } from 'typeorm';

// See docs/architecture.md §5 and ADR-0016. `chargeback_transaction_id` is a
// cross-module reference into `ledger`'s `transactions` — no FK, same as
// every other cross-module reference (ADR-0002). `user_id` is deliberately
// not stored — derivable via chargeback_transaction_id -> accounts.user_id,
// and storing it redundantly risks drift (same reasoning as
// sender_wallet_id/recipient_wallet_id being denormalized-not-authoritative
// elsewhere in this schema).
export class CreateDisputes1787500000000 implements MigrationInterface {
  name = 'CreateDisputes1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "disputes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "chargeback_transaction_id" uuid NOT NULL,
        "dispute_reference" varchar NOT NULL,
        "status" varchar NOT NULL,
        "amount" bigint NOT NULL,
        "currency" varchar NOT NULL,
        "resolved_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_disputes_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_disputes_dispute_reference" UNIQUE ("dispute_reference"),
        CONSTRAINT "CHK_disputes_status" CHECK ("status" IN ('open', 'resolved', 'upheld'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_disputes_chargeback_transaction_id" ON "disputes" ("chargeback_transaction_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "disputes"`);
  }
}
