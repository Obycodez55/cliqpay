import { MigrationInterface, QueryRunner } from 'typeorm';

// See docs/architecture.md §5 and ADR-0012. `requester_user_id`/
// `payer_user_id` are cross-module references into `users` (no FK, same as
// every other cross-module reference). `transaction_id` is also a
// cross-module reference — it points at `transactions`, owned by `ledger`,
// not `transfers` — so it stays a plain nullable uuid too, even though
// architecture.md's schema block lists it without the "no FK" annotation
// it gives the other two.
//
// `status` deliberately has no `expired` value (ADR-0012) — expiry is
// derived from `expires_at` at read time.
export class CreateMoneyRequests1786900000000 implements MigrationInterface {
  name = 'CreateMoneyRequests1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "money_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "requester_user_id" uuid NOT NULL,
        "payer_user_id" uuid NOT NULL,
        "amount" bigint NOT NULL,
        "currency" varchar NOT NULL,
        "note" varchar,
        "status" varchar NOT NULL,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "transaction_id" uuid,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_money_requests_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_money_requests_status" CHECK ("status" IN ('pending', 'paid', 'declined', 'cancelled'))
      )
    `);
    // Backs both list endpoints: WHERE payer_user_id = ... / requester_user_id
    // = ... ORDER BY created_at DESC, id DESC.
    await queryRunner.query(`
      CREATE INDEX "IDX_money_requests_payer_user_id_created_at"
      ON "money_requests" ("payer_user_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_money_requests_requester_user_id_created_at"
      ON "money_requests" ("requester_user_id", "created_at" DESC)
    `);
    // Backs the pair-cap count: WHERE requester_user_id = ... AND
    // payer_user_id = ... AND status = 'pending' AND expires_at > now().
    // Partial on status so the index only carries rows a cap check (or
    // cancel/decline) could ever match.
    await queryRunner.query(`
      CREATE INDEX "IDX_money_requests_pair_pending"
      ON "money_requests" ("requester_user_id", "payer_user_id", "expires_at")
      WHERE "status" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_money_requests_pair_pending"`);
    await queryRunner.query(
      `DROP INDEX "IDX_money_requests_requester_user_id_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_money_requests_payer_user_id_created_at"`,
    );
    await queryRunner.query(`DROP TABLE "money_requests"`);
  }
}
