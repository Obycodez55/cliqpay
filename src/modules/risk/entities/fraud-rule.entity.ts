import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const FRAUD_RULE_CODES = [
  'mule_fan_in',
  'new_account_large_withdrawal',
  'tainted_inflow',
  'send_burst',
  'shared_device',
  'device_integrity',
  'scam_report',
] as const;
export type FraudRuleCode = (typeof FRAUD_RULE_CODES)[number];

export const FRAUD_RULE_MODES = ['off', 'shadow', 'enforce'] as const;
export type FraudRuleMode = (typeof FRAUD_RULE_MODES)[number];

@Entity('fraud_rules')
@Check('CHK_fraud_rules_code', inList('code', FRAUD_RULE_CODES))
@Check('CHK_fraud_rules_mode', inList('mode', FRAUD_RULE_MODES))
@Unique('UQ_fraud_rules_code', ['code'])
export class FraudRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar')
  code: FraudRuleCode;

  @Column('varchar')
  mode: FraudRuleMode;

  @Column({ type: 'jsonb', default: () => `'{}'` })
  params: Record<string, number>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
