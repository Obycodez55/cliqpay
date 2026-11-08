import { MigrationInterface, QueryRunner } from 'typeorm';

const WITH_NEW_CODES = `'insufficient_balance', 'daily_limit_exceeded', 'recipient_cap', 'blocked', 'recipient_unavailable', 'sender_frozen', 'bank_account_removed', 'payout_rejected', 'amount_below_minimum', 'sender_unverified', 'infrastructure'`;
const WITHOUT_NEW_CODES = `'insufficient_balance', 'daily_limit_exceeded', 'recipient_cap', 'blocked', 'recipient_unavailable', 'sender_frozen', 'bank_account_removed', 'payout_rejected', 'infrastructure'`;

export class AddAmountBelowMinimumFailureCode1794161900000 implements MigrationInterface {
  name = 'AddAmountBelowMinimumFailureCode1794161900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.replaceCheck(queryRunner, WITH_NEW_CODES);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.replaceCheck(queryRunner, WITHOUT_NEW_CODES);
  }

  private async replaceCheck(
    queryRunner: QueryRunner,
    codes: string,
  ): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" DROP CONSTRAINT "CHK_scheduled_payment_attempts_failure_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_payment_attempts" ADD CONSTRAINT "CHK_scheduled_payment_attempts_failure_code" CHECK ("failure_code" IS NULL OR "failure_code" IN (${codes}))`,
    );
  }
}
