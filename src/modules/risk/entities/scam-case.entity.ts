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

export const SCAM_CATEGORIES = [
  'impersonation',
  'fake_goods_or_services',
  'investment',
  'romance',
  'other',
] as const;
export type ScamCategory = (typeof SCAM_CATEGORIES)[number];

export const SCAM_CASE_STATUSES = [
  'open',
  'upheld',
  'rejected',
  'withdrawn',
] as const;
export type ScamCaseStatus = (typeof SCAM_CASE_STATUSES)[number];

const bigintTransformer = {
  to: (v: bigint | null) => v,
  from: (v: string | null) => (v === null ? null : BigInt(v)),
};

@Entity('scam_cases')
@Check('CHK_scam_cases_category', inList('category', SCAM_CATEGORIES))
@Check('CHK_scam_cases_status', inList('status', SCAM_CASE_STATUSES))
@Check(
  'CHK_scam_cases_amounts',
  `"reported_amount" > 0 AND "held_amount" >= 0 AND "held_amount" <= "reported_amount" AND "recovered_amount" >= 0 AND "recovered_amount" <= "held_amount" AND ("reimbursed_amount" IS NULL OR "reimbursed_amount" >= 0)`,
)
@Index('UQ_scam_cases_reference', ['reference'], { unique: true })
@Index('UQ_scam_cases_transaction', ['transactionId'], { unique: true })
@Index('IDX_scam_cases_reporter', ['reporterUserId', 'createdAt'])
@Index('IDX_scam_cases_open_recipient', ['recipientUserId'], {
  where: `"status" = 'open'`,
})
@Index('IDX_scam_cases_open_due', ['dueAt'], { where: `"status" = 'open'` })
export class ScamCase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar')
  reference: string;

  @Column('uuid')
  transactionId: string;

  @Column('uuid')
  reporterUserId: string;

  @Column('uuid')
  recipientUserId: string;

  @Column('varchar')
  currency: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  reportedAmount: bigint;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  heldAmount: bigint;

  @Column({ type: 'bigint', default: 0, transformer: bigintTransformer })
  recoveredAmount: bigint;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  reimbursedAmount: bigint | null;

  @Column('varchar')
  category: ScamCategory;

  @Column('varchar')
  description: string;

  @Column({ type: 'varchar', nullable: true })
  contactChannel: string | null;

  @Column('varchar', { default: 'open' })
  status: ScamCaseStatus;

  @Column('boolean', { default: false })
  late: boolean;

  @Column({ type: 'timestamptz' })
  dueAt: Date;

  @Column({ type: 'varchar', nullable: true })
  recipientResponse: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  recipientRespondedAt: Date | null;

  @Column('boolean', { default: false })
  restrictionAdded: boolean;

  @Column({ type: 'varchar', nullable: true })
  decisionReason: string | null;

  @Column({ type: 'varchar', nullable: true })
  decidedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
