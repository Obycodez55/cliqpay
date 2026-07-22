import { MigrationInterface, QueryRunner } from 'typeorm';

// See ADR-0004.
export class ConvertPushTokensTimestamps1784707276059 implements MigrationInterface {
  name = 'ConvertPushTokensTimestamps1784707276059';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "push_tokens"
        ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "last_used_at" TYPE TIMESTAMPTZ USING "last_used_at" AT TIME ZONE 'UTC'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "push_tokens"
        ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "last_used_at" TYPE TIMESTAMP USING "last_used_at" AT TIME ZONE 'UTC'
    `);
  }
}
