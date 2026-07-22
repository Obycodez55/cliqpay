import { MigrationInterface, QueryRunner } from 'typeorm';

// See ADR-0004.
export class ConvertSessionsTimestamps1784707276058 implements MigrationInterface {
  name = 'ConvertSessionsTimestamps1784707276058';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sessions"
        ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ USING "expires_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "last_used_at" TYPE TIMESTAMPTZ USING "last_used_at" AT TIME ZONE 'UTC'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sessions"
        ALTER COLUMN "expires_at" TYPE TIMESTAMP USING "expires_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "last_used_at" TYPE TIMESTAMP USING "last_used_at" AT TIME ZONE 'UTC'
    `);
  }
}
