import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBillSplitCompletionTimestamps1794059178152 implements MigrationInterface {
  name = 'AddBillSplitCompletionTimestamps1794059178152';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bill_splits" ADD "completed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "bill_splits" ADD "closed_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bill_splits" DROP COLUMN "closed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bill_splits" DROP COLUMN "completed_at"`,
    );
  }
}
