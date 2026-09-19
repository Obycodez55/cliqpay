import { MigrationInterface, QueryRunner } from 'typeorm';

// `chargeback_reversal` (the second compensating transaction for a dispute
// resolved in Cliqpay's favor — docs/architecture.md §4.2, ADR-0016, issue
// #36) was added to TransactionType (transaction.entity.ts) but never to
// this constraint, same gap AddWithdrawalReversalTransactionType fixed for
// `withdrawal_reversal`.
export class AddChargebackReversalTransactionType1787500000002 implements MigrationInterface {
  name = 'AddChargebackReversalTransactionType1787500000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_type"
        CHECK ("type" IN ('funding', 'p2p_transfer', 'withdrawal', 'withdrawal_reversal', 'chargeback', 'chargeback_reversal', 'profit_withdrawal', 'bill_split', 'scheduled'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_type"
        CHECK ("type" IN ('funding', 'p2p_transfer', 'withdrawal', 'withdrawal_reversal', 'chargeback', 'profit_withdrawal', 'bill_split', 'scheduled'))
    `);
  }
}
