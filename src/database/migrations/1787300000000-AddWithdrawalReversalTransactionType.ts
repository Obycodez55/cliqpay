import { MigrationInterface, QueryRunner } from 'typeorm';

// `withdrawal_reversal` (the compensating transaction for a payout that
// didn't go through — docs/architecture.md §4.2, §7) was added to
// TransactionType (transaction.entity.ts) for issue #28 but never to this
// constraint, so LedgerService.reverseWithdrawalEntries fails against a real
// database the moment a payout is actually rejected.
export class AddWithdrawalReversalTransactionType1787300000000 implements MigrationInterface {
  name = 'AddWithdrawalReversalTransactionType1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_type"
        CHECK ("type" IN ('funding', 'p2p_transfer', 'withdrawal', 'withdrawal_reversal', 'chargeback', 'profit_withdrawal', 'bill_split', 'scheduled'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_type"
        CHECK ("type" IN ('funding', 'p2p_transfer', 'withdrawal', 'chargeback', 'profit_withdrawal', 'bill_split', 'scheduled'))
    `);
  }
}
