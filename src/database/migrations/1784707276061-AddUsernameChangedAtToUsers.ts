import { MigrationInterface, QueryRunner } from 'typeorm';

// Nullable, per ADR-0004 (timestamptz) — null means "never changed since
// registration", so the 30-day cooldown check in AuthService.updateProfile
// treats it as always-allowed rather than needing a registration-time
// backfill.
export class AddUsernameChangedAtToUsers1784707276061 implements MigrationInterface {
  name = 'AddUsernameChangedAtToUsers1784707276061';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN "username_changed_at" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "username_changed_at"
    `);
  }
}
