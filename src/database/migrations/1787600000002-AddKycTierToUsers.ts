import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKycTierToUsers1787600000002 implements MigrationInterface {
  name = 'AddKycTierToUsers1787600000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN "kyc_tier" varchar NOT NULL DEFAULT 'tier0',
        ADD CONSTRAINT "CHK_users_kyc_tier" CHECK ("kyc_tier" IN ('tier0', 'tier1', 'tier2', 'tier3'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP CONSTRAINT "CHK_users_kyc_tier",
        DROP COLUMN "kyc_tier"
    `);
  }
}
