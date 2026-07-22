import { MigrationInterface, QueryRunner } from 'typeorm';

// See ADR-0004 — every `timestamp` (no time zone) column round-trips
// incorrectly through TypeORM/node-postgres once the app process isn't
// running in UTC. `USING <col> AT TIME ZONE 'UTC'` treats existing values as
// already UTC — the safe assumption with no production data yet.
export class ConvertUsersAndAccountsTimestamps1784707276057 implements MigrationInterface {
  name = 'ConvertUsersAndAccountsTimestamps1784707276057';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ALTER COLUMN "email_verified_at" TYPE TIMESTAMPTZ USING "email_verified_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "phone_verified_at" TYPE TIMESTAMPTZ USING "phone_verified_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "locked_until" TYPE TIMESTAMPTZ USING "locked_until" AT TIME ZONE 'UTC',
        ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ USING "updated_at" AT TIME ZONE 'UTC'
    `);

    await queryRunner.query(`
      ALTER TABLE "accounts"
        ALTER COLUMN "created_at" TYPE TIMESTAMPTZ USING "created_at" AT TIME ZONE 'UTC'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "accounts"
        ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE 'UTC'
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
        ALTER COLUMN "email_verified_at" TYPE TIMESTAMP USING "email_verified_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "phone_verified_at" TYPE TIMESTAMP USING "phone_verified_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "locked_until" TYPE TIMESTAMP USING "locked_until" AT TIME ZONE 'UTC',
        ALTER COLUMN "created_at" TYPE TIMESTAMP USING "created_at" AT TIME ZONE 'UTC',
        ALTER COLUMN "updated_at" TYPE TIMESTAMP USING "updated_at" AT TIME ZONE 'UTC'
    `);
  }
}
