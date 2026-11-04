import { MigrationInterface, QueryRunner } from 'typeorm';

// Same default, spelled the way TypeORM compares it: it normalizes an entity
// default of CURRENT_TIMESTAMP to now(), so the original spelling reported
// permanent drift in `migration:check`.
export class SetPushTokensLastUsedAtDefaultNow1787800000000 implements MigrationInterface {
  name = 'SetPushTokensLastUsedAtDefaultNow1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "push_tokens" ALTER COLUMN "last_used_at" SET DEFAULT now()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "push_tokens" ALTER COLUMN "last_used_at" SET DEFAULT CURRENT_TIMESTAMP
    `);
  }
}
