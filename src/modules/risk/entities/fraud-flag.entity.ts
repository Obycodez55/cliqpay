import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const FRAUD_FLAG_KINDS = ['fraud', 'aml'] as const;
export type FraudFlagKind = (typeof FRAUD_FLAG_KINDS)[number];

export const FRAUD_FLAG_STATUSES = [
  'open',
  'reviewing',
  'cleared',
  'confirmed',
] as const;
export type FraudFlagStatus = (typeof FRAUD_FLAG_STATUSES)[number];

export const OPEN_FLAG_STATUSES = ['open', 'reviewing'] as const;

@Entity('fraud_flags')
@Check('CHK_fraud_flags_kind', inList('kind', FRAUD_FLAG_KINDS))
@Check('CHK_fraud_flags_status', inList('status', FRAUD_FLAG_STATUSES))
@Check('CHK_fraud_flags_hit_count_positive', `"hit_count" >= 1`)
@Index('UQ_fraud_flags_open_user_rule', ['userId', 'ruleCode'], {
  unique: true,
  where: `"status" IN ('open', 'reviewing')`,
})
@Index('IDX_fraud_flags_user', ['userId'])
@Index('IDX_fraud_flags_open_created', ['createdAt'], {
  where: `"status" IN ('open', 'reviewing')`,
})
export class FraudFlag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column('varchar')
  kind: FraudFlagKind;

  @Column('varchar')
  ruleCode: string;

  @Column({ type: 'uuid', nullable: true })
  transactionId: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  evidence: Record<string, unknown>[];

  @Column({ type: 'integer', default: 1 })
  hitCount: number;

  @Column('varchar', { default: 'open' })
  status: FraudFlagStatus;

  @Column('boolean')
  enforced: boolean;

  @Column({ type: 'varchar', nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  reviewNote: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
