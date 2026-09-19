import { MigrationInterface, QueryRunner } from 'typeorm';

// See docs/architecture.md §5 note on `users.isFrozen` and ADR-0016. Set
// only via UsersService.freeze() — never automatically from a balance
// crossing zero through ordinary funding. Not Phase-5-specific: Phase 11's
// fraud work reuses this same column.
export class AddIsFrozenToUsers1787500000001 implements MigrationInterface {
  name = 'AddIsFrozenToUsers1787500000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN "is_frozen" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "is_frozen"
    `);
  }
}
