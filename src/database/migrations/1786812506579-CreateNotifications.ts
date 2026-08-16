import { MigrationInterface, QueryRunner } from 'typeorm';

// The in-app notification channel (issue #20, docs/adr/0013). `user_id` is
// a cross-module reference (auth/users owns that table) — no FK, same as
// every other cross-module reference in this codebase. The unique
// constraint on (user_id, type, dedupe_key) is what makes a worker that
// writes a row and dies before acking safe to retry: the retry's insert
// hits this constraint instead of creating a duplicate.
export class CreateNotifications1786812506579 implements MigrationInterface {
  name = 'CreateNotifications1786812506579';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "type" varchar NOT NULL,
        "data" jsonb NOT NULL DEFAULT '{}',
        "title" varchar NOT NULL,
        "body" text NOT NULL,
        "dedupe_key" varchar NOT NULL,
        "read_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_notifications_user_id_type_dedupe_key" UNIQUE ("user_id", "type", "dedupe_key")
      )
    `);
    // List query: WHERE user_id = ... ORDER BY created_at DESC, id DESC.
    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_user_id_created_at"
      ON "notifications" ("user_id", "created_at" DESC)
    `);
    // Unread-count query: WHERE user_id = ... AND read_at IS NULL — partial
    // so the index only covers the rows that query actually scans.
    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_user_id_unread"
      ON "notifications" ("user_id")
      WHERE "read_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notifications_user_id_unread"`);
    await queryRunner.query(
      `DROP INDEX "IDX_notifications_user_id_created_at"`,
    );
    await queryRunner.query(`DROP TABLE "notifications"`);
  }
}
