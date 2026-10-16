import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTierLimits1787600000001 implements MigrationInterface {
  name = 'CreateTierLimits1787600000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tier_limits" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tier" varchar NOT NULL,
        "currency" varchar NOT NULL,
        "daily_debit_limit_minor" bigint NOT NULL,
        "balance_cap_minor" bigint,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tier_limits_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tier_limits_tier_currency" UNIQUE ("tier", "currency"),
        CONSTRAINT "CHK_tier_limits_tier" CHECK ("tier" IN ('tier0', 'tier1', 'tier2', 'tier3'))
      )
    `);

    // Reference snapshot, not a live CBN figure.
    await queryRunner.query(`
      INSERT INTO "tier_limits"
        ("tier", "currency", "daily_debit_limit_minor", "balance_cap_minor")
      VALUES
        ('tier0', 'NGN', 0, 0),
        ('tier1', 'NGN', 5000000, 30000000),
        ('tier2', 'NGN', 20000000, 50000000),
        ('tier3', 'NGN', 500000000, NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "tier_limits"`);
  }
}
