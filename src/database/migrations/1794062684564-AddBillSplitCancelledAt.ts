import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBillSplitCancelledAt1794062684564 implements MigrationInterface {
  name = 'AddBillSplitCancelledAt1794062684564';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bill_splits" ADD "cancelled_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bill_splits" DROP COLUMN "cancelled_at"`,
    );
  }
}
