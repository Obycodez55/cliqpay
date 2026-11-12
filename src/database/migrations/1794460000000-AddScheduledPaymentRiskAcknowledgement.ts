import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduledPaymentRiskAcknowledgement1794460000000 implements MigrationInterface {
  name = 'AddScheduledPaymentRiskAcknowledgement1794460000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" ADD "risk_acknowledgement" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_payments" DROP COLUMN "risk_acknowledgement"`,
    );
  }
}
