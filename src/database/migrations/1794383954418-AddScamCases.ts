import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  FRAUD_HOLD_ACCOUNT,
  seedSystemAccounts,
} from '../seed-system-accounts';

const TRANSACTION_TYPES_BEFORE = `'funding', 'funding_refund', 'p2p_transfer', 'withdrawal', 'withdrawal_reversal', 'chargeback', 'chargeback_reversal', 'profit_withdrawal', 'bill_split', 'scheduled'`;
const ACCOUNT_ROLES_BEFORE = `'float', 'fee_income', 'fee_expense', 'fee_recovery', 'suspense', 'user_wallet'`;
const ACCOUNT_ROLES_AFTER = `'float', 'fee_income', 'fee_expense', 'fee_recovery', 'suspense', 'fraud_hold', 'user_wallet'`;
const RULE_CODES_BEFORE = `'mule_fan_in', 'new_account_large_withdrawal', 'tainted_inflow', 'send_burst', 'shared_device', 'device_integrity'`;

export class AddScamCases1794383954418 implements MigrationInterface {
  name = 'AddScamCases1794383954418';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "scam_cases" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "reference" character varying NOT NULL, "transaction_id" uuid NOT NULL, "reporter_user_id" uuid NOT NULL, "recipient_user_id" uuid NOT NULL, "currency" character varying NOT NULL, "reported_amount" bigint NOT NULL, "held_amount" bigint NOT NULL DEFAULT '0', "recovered_amount" bigint NOT NULL DEFAULT '0', "reimbursed_amount" bigint, "category" character varying NOT NULL, "description" character varying NOT NULL, "contact_channel" character varying, "status" character varying NOT NULL DEFAULT 'open', "late" boolean NOT NULL DEFAULT false, "due_at" TIMESTAMP WITH TIME ZONE NOT NULL, "recipient_response" character varying, "recipient_responded_at" TIMESTAMP WITH TIME ZONE, "restriction_added" boolean NOT NULL DEFAULT false, "decision_reason" character varying, "decided_by" character varying, "decided_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_scam_cases_amounts" CHECK ("reported_amount" > 0 AND "held_amount" >= 0 AND "held_amount" <= "reported_amount" AND "recovered_amount" >= 0 AND "recovered_amount" <= "held_amount" AND ("reimbursed_amount" IS NULL OR "reimbursed_amount" >= 0)), CONSTRAINT "CHK_scam_cases_status" CHECK ("status" IN ('open', 'upheld', 'rejected', 'withdrawn')), CONSTRAINT "CHK_scam_cases_category" CHECK ("category" IN ('impersonation', 'fake_goods_or_services', 'investment', 'romance', 'other')), CONSTRAINT "PK_498b43c380c0b745b53c161a996" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scam_cases_open_due" ON "scam_cases"  ("due_at") WHERE "status" = 'open'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scam_cases_open_recipient" ON "scam_cases"  ("recipient_user_id") WHERE "status" = 'open'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scam_cases_reporter" ON "scam_cases"  ("reporter_user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_scam_cases_transaction" ON "scam_cases"  ("transaction_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_scam_cases_reference" ON "scam_cases"  ("reference") `,
    );
    await queryRunner.query(`CREATE SEQUENCE "scam_case_reference_seq"`);

    await this.replaceCheck(
      queryRunner,
      'transactions',
      'CHK_transactions_type',
      'type',
      `${TRANSACTION_TYPES_BEFORE}, 'fraud_hold', 'fraud_hold_release', 'scam_recovery'`,
    );
    await this.replaceCheck(
      queryRunner,
      'accounts',
      'CHK_accounts_role',
      'role',
      ACCOUNT_ROLES_AFTER,
    );
    await this.replaceCheck(
      queryRunner,
      'fraud_rules',
      'CHK_fraud_rules_code',
      'code',
      `${RULE_CODES_BEFORE}, 'scam_report'`,
    );

    await seedSystemAccounts(queryRunner, 'NGN', [FRAUD_HOLD_ACCOUNT]);
    await queryRunner.query(`
      INSERT INTO "fraud_rules" ("code", "mode", "params")
      VALUES ('scam_report', 'enforce', '{"minDistinctReporters": 2, "windowDays": 30}')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "fraud_rules" WHERE "code" = 'scam_report'`,
    );
    await queryRunner.query(
      `DELETE FROM "accounts" WHERE "role" = 'fraud_hold'`,
    );
    await this.replaceCheck(
      queryRunner,
      'fraud_rules',
      'CHK_fraud_rules_code',
      'code',
      RULE_CODES_BEFORE,
    );
    await this.replaceCheck(
      queryRunner,
      'accounts',
      'CHK_accounts_role',
      'role',
      ACCOUNT_ROLES_BEFORE,
    );
    await this.replaceCheck(
      queryRunner,
      'transactions',
      'CHK_transactions_type',
      'type',
      TRANSACTION_TYPES_BEFORE,
    );
    await queryRunner.query(`DROP SEQUENCE "scam_case_reference_seq"`);
    await queryRunner.query(`DROP TABLE "scam_cases"`);
  }

  private async replaceCheck(
    queryRunner: QueryRunner,
    table: string,
    constraint: string,
    column: string,
    values: string,
  ): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`,
    );
    await queryRunner.query(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" CHECK ("${column}" IN (${values}))`,
    );
  }
}
