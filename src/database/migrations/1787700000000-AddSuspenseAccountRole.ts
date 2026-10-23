import { MigrationInterface, QueryRunner } from 'typeorm';
import { seedSystemAccounts } from '../seed-system-accounts';

// Money a provider holds that is owed back to a payer rather than to a user
// wallet: a funding held because crediting it would breach the balance cap
// (docs/adr/0021). Provider-scoped like float.
export class AddSuspenseAccountRole1787700000000 implements MigrationInterface {
  name = 'AddSuspenseAccountRole1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "accounts" DROP CONSTRAINT "CHK_accounts_role"
    `);
    await queryRunner.query(`
      ALTER TABLE "accounts" ADD CONSTRAINT "CHK_accounts_role"
        CHECK ("role" IN ('float', 'fee_income', 'fee_expense', 'fee_recovery', 'suspense', 'user_wallet'))
    `);
    await seedSystemAccounts(queryRunner, 'NGN');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "accounts" WHERE "role" = 'suspense'`);
    await queryRunner.query(`
      ALTER TABLE "accounts" DROP CONSTRAINT "CHK_accounts_role"
    `);
    await queryRunner.query(`
      ALTER TABLE "accounts" ADD CONSTRAINT "CHK_accounts_role"
        CHECK ("role" IN ('float', 'fee_income', 'fee_expense', 'fee_recovery', 'user_wallet'))
    `);
  }
}
