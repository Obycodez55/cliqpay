import { MigrationInterface, QueryRunner } from 'typeorm';

// See docs/architecture.md §5. Both tables are created together here even
// though issue #12 (funding initiation) only writes to `transactions` —
// `ledger_entries` is needed immediately next by issue #13 (funding
// posting), and splitting one schema's two tightly-coupled tables across
// two migrations buys nothing. `ledger_entries` stays append-only from the
// start (no `updated_at`) per docs/architecture.md §7 Data Integrity.
export class CreateTransactionsAndLedgerEntries1784707276066 implements MigrationInterface {
  name = 'CreateTransactionsAndLedgerEntries1784707276066';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "transactions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "reference" varchar NOT NULL,
        "provider" varchar,
        "provider_reference" varchar,
        "type" varchar NOT NULL,
        "status" varchar NOT NULL,
        "reverses_transaction_id" uuid,
        "amount" bigint NOT NULL,
        "currency" varchar NOT NULL,
        "sender_wallet_id" uuid,
        "recipient_wallet_id" uuid,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_transactions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_transactions_reference" UNIQUE ("reference"),
        CONSTRAINT "CHK_transactions_provider" CHECK ("provider" IN ('kora')),
        CONSTRAINT "CHK_transactions_type" CHECK ("type" IN ('funding', 'p2p_transfer', 'withdrawal', 'chargeback', 'profit_withdrawal', 'bill_split', 'scheduled')),
        CONSTRAINT "CHK_transactions_status" CHECK ("status" IN ('pending', 'completed', 'failed', 'reversed', 'disputed')),
        CONSTRAINT "FK_transactions_reverses_transaction_id" FOREIGN KEY ("reverses_transaction_id") REFERENCES "transactions" ("id"),
        CONSTRAINT "FK_transactions_sender_wallet_id" FOREIGN KEY ("sender_wallet_id") REFERENCES "accounts" ("id"),
        CONSTRAINT "FK_transactions_recipient_wallet_id" FOREIGN KEY ("recipient_wallet_id") REFERENCES "accounts" ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_transactions_provider_reference" ON "transactions" ("provider_reference")
    `);

    await queryRunner.query(`
      CREATE TABLE "ledger_entries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "transaction_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "direction" varchar NOT NULL,
        "amount" bigint NOT NULL,
        "running_balance" bigint NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ledger_entries_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_ledger_entries_direction" CHECK ("direction" IN ('debit', 'credit')),
        CONSTRAINT "FK_ledger_entries_transaction_id" FOREIGN KEY ("transaction_id") REFERENCES "transactions" ("id"),
        CONSTRAINT "FK_ledger_entries_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_ledger_entries_transaction_id" ON "ledger_entries" ("transaction_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_ledger_entries_account_id" ON "ledger_entries" ("account_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ledger_entries"`);
    await queryRunner.query(`DROP TABLE "transactions"`);
  }
}
