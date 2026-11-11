import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCredentialPasswordResetAt1794355032347 implements MigrationInterface {
  name = 'AddCredentialPasswordResetAt1794355032347';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "credentials" ADD "password_reset_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "credentials" DROP COLUMN "password_reset_at"`,
    );
  }
}
