import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRiskModule1794380007417 implements MigrationInterface {
  name = 'AddRiskModule1794380007417';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "fraud_flags" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "kind" character varying NOT NULL, "rule_code" character varying NOT NULL, "transaction_id" uuid, "evidence" jsonb NOT NULL DEFAULT '[]', "hit_count" integer NOT NULL DEFAULT '1', "status" character varying NOT NULL DEFAULT 'open', "enforced" boolean NOT NULL, "reviewed_by" character varying, "reviewed_at" TIMESTAMP WITH TIME ZONE, "review_note" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_fraud_flags_hit_count_positive" CHECK ("hit_count" >= 1), CONSTRAINT "CHK_fraud_flags_status" CHECK ("status" IN ('open', 'reviewing', 'cleared', 'confirmed')), CONSTRAINT "CHK_fraud_flags_kind" CHECK ("kind" IN ('fraud', 'aml')), CONSTRAINT "PK_00fccadb758d1624e0831fe026a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fraud_flags_open_created" ON "fraud_flags"  ("created_at") WHERE "status" IN ('open', 'reviewing')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fraud_flags_user" ON "fraud_flags"  ("user_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_fraud_flags_open_user_rule" ON "fraud_flags"  ("user_id", "rule_code") WHERE "status" IN ('open', 'reviewing')`,
    );
    await queryRunner.query(
      `CREATE TABLE "fraud_rules" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "code" character varying NOT NULL, "mode" character varying NOT NULL, "params" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_fraud_rules_code" UNIQUE ("code"), CONSTRAINT "CHK_fraud_rules_mode" CHECK ("mode" IN ('off', 'shadow', 'enforce')), CONSTRAINT "CHK_fraud_rules_code" CHECK ("code" IN ('mule_fan_in', 'new_account_large_withdrawal', 'tainted_inflow', 'send_burst', 'shared_device', 'device_integrity')), CONSTRAINT "PK_5fabae585c6ce9ec162fc31d5d9" PRIMARY KEY ("id"))`,
    );

    await this.replaceStatusCheck(
      queryRunner,
      `'pending', 'under_review', 'completed', 'failed', 'reversed', 'disputed', 'held', 'refunded'`,
    );

    await queryRunner.query(`
      INSERT INTO "fraud_rules" ("code", "mode", "params")
      VALUES
        ('mule_fan_in', 'enforce', '{"minDistinctSenders": 5, "windowHours": 24, "minWithdrawalSharePercent": 50}'),
        ('new_account_large_withdrawal', 'enforce', '{"maxAccountAgeDays": 7, "minAmountMinor": 10000000}'),
        ('tainted_inflow', 'enforce', '{"minAmountMinor": 500000, "windowHours": 72}'),
        ('send_burst', 'shadow', '{"burstSends": 10, "burstWindowMinutes": 10, "newRecipients": 5, "newRecipientWindowMinutes": 60}'),
        ('shared_device', 'shadow', '{"minUsers": 3, "windowDays": 30}'),
        ('device_integrity', 'shadow', '{}')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "fraud_rules"`);
    await queryRunner.query(`DROP TABLE "fraud_flags"`);
    await queryRunner.query(
      `UPDATE "transactions" SET "status" = 'pending' WHERE "status" = 'under_review'`,
    );
    await this.replaceStatusCheck(
      queryRunner,
      `'pending', 'completed', 'failed', 'reversed', 'disputed', 'held', 'refunded'`,
    );
  }

  private async replaceStatusCheck(
    queryRunner: QueryRunner,
    statuses: string,
  ): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_status" CHECK ("status" IN (${statuses}))`,
    );
  }
}
