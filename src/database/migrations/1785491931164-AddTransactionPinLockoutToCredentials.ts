import { MigrationInterface, QueryRunner } from 'typeorm';

// Deliberately separate from `failed_login_attempts`/`locked_until` — see
// ADR-0009 — reusing the login lockout columns for PIN failures would let a
// PIN-guessing attacker lock the real user out of login, which is precisely
// what they need in order to reset the PIN and evict the attacker.
export class AddTransactionPinLockoutToCredentials1785491931164 implements MigrationInterface {
  name = 'AddTransactionPinLockoutToCredentials1785491931164';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credentials"
        ADD COLUMN "failed_pin_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN "pin_locked_until" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credentials"
        DROP COLUMN "failed_pin_attempts",
        DROP COLUMN "pin_locked_until"
    `);
  }
}
