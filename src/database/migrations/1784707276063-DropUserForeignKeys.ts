import { MigrationInterface, QueryRunner } from 'typeorm';

// `User` moved from the `auth` module to the new `users` module (ADR-0005)
// — every FK from an `auth`-owned table into `users(id)` becomes a
// cross-module reference the moment that split happens, so per ADR-0002 it
// can no longer be a real FK constraint. The columns and their indexes are
// untouched; only referential integrity at the DB level is dropped in favor
// of application-level correctness, same as `accounts.user_id`/
// `push_tokens.user_id` already are.
export class DropUserForeignKeys1784707276063 implements MigrationInterface {
  name = 'DropUserForeignKeys1784707276063';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP CONSTRAINT "FK_sessions_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "verification_codes" DROP CONSTRAINT "FK_verification_codes_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mfa_methods" DROP CONSTRAINT "FK_mfa_methods_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" DROP CONSTRAINT "FK_trusted_devices_user_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "trusted_devices" ADD CONSTRAINT "FK_trusted_devices_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "mfa_methods" ADD CONSTRAINT "FK_mfa_methods_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "verification_codes" ADD CONSTRAINT "FK_verification_codes_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD CONSTRAINT "FK_sessions_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id")`,
    );
  }
}
