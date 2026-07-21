import { QueryRunner } from 'typeorm';

// Provider-scoped roles (float/fee_expense/fee_recovery) always seed at
// 'kora' — the only active provider right now (docs/architecture.md §3.6).
// fee_income is provider-agnostic (null) per §4.1. Lives outside
// database/migrations/ deliberately — TypeORM's migration glob loader
// treats every export of a file under that directory as a migration class
// constructor, so a plain function there breaks `DataSource.initialize()`.
const SYSTEM_ACCOUNTS: {
  type: string;
  role: string;
  provider: string | null;
}[] = [
  { type: 'asset', role: 'float', provider: 'kora' },
  { type: 'expense', role: 'fee_expense', provider: 'kora' },
  { type: 'equity', role: 'fee_recovery', provider: 'kora' },
  { type: 'equity', role: 'fee_income', provider: null },
];

/**
 * Idempotent by construction (ON CONFLICT against the partial unique index
 * created in CreateUsersAndAccounts) — safe to re-invoke, which is exactly
 * what happens when a later migration activates a new currency (import this
 * function, call it again with the new currency code) rather than
 * duplicating the inserts.
 */
export async function seedSystemAccounts(
  queryRunner: QueryRunner,
  currency: string,
): Promise<void> {
  for (const account of SYSTEM_ACCOUNTS) {
    await queryRunner.query(
      `INSERT INTO "accounts" ("type", "role", "provider", "currency", "balance")
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT ("role", "provider", "currency") WHERE "user_id" IS NULL
       DO NOTHING`,
      [account.type, account.role, account.provider, currency],
    );
  }
}
