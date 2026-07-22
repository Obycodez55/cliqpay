import { MigrationInterface, QueryRunner } from 'typeorm';

// See ADR-0004.
export class ConvertMfaAndTrustedDevicesTimestamps1784707276060 implements MigrationInterface {
  name = 'ConvertMfaAndTrustedDevicesTimestamps1784707276060';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "mfa_methods"
        ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ USING "updated_at" AT TIME ZONE 'UTC'
    `);

    await queryRunner.query(`
      ALTER TABLE "mfa_challenges"
        ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ USING "expires_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC'
    `);

    await queryRunner.query(`
      ALTER TABLE "trusted_devices"
        ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ USING "expires_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "last_used_at" TYPE TIMESTAMPTZ USING "last_used_at" AT TIME ZONE 'UTC'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trusted_devices"
        ALTER COLUMN "expires_at" TYPE TIMESTAMP USING "expires_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "last_used_at" TYPE TIMESTAMP USING "last_used_at" AT TIME ZONE 'UTC'
    `);

    await queryRunner.query(`
      ALTER TABLE "mfa_challenges"
        ALTER COLUMN "expires_at" TYPE TIMESTAMP USING "expires_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE 'UTC'
    `);

    await queryRunner.query(`
      ALTER TABLE "mfa_methods"
        ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "updated_at" TYPE TIMESTAMP USING "updated_at" AT TIME ZONE 'UTC'
    `);
  }
}
