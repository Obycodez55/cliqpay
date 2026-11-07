import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const BILL_SPLIT_MODES = ['equal', 'custom'] as const;
export type BillSplitMode = (typeof BILL_SPLIT_MODES)[number];

const bigintTransformer = {
  to: (v: bigint) => v,
  from: (v: string) => BigInt(v),
};

// See docs/architecture.md §5 and ADR-0026. `initiatorUserId` is a
// cross-module reference, so a plain column with no relation (ADR-0002). The
// index also carries `created_at DESC, id DESC` in the migration; an entity
// can't express descending columns.
@Entity('bill_splits')
@Check('CHK_bill_splits_mode', inList('mode', BILL_SPLIT_MODES))
@Unique('UQ_bill_splits_initiator_user_id_reference', [
  'initiatorUserId',
  'reference',
])
@Index('IDX_bill_splits_initiator_user_id_created_at', [
  'initiatorUserId',
  'createdAt',
  'id',
])
export class BillSplit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  initiatorUserId: string;

  @Column('varchar')
  reference: string;

  @Column('varchar', { length: 140 })
  description: string;

  @Column('varchar')
  mode: BillSplitMode;

  @Column('bigint', { transformer: bigintTransformer })
  totalAmount: bigint;

  @Column('bigint', { transformer: bigintTransformer })
  initiatorShare: bigint;

  @Column('varchar')
  currency: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
