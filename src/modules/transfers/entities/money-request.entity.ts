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

export const MONEY_REQUEST_STATUSES = [
  'pending',
  'paid',
  'declined',
  'cancelled',
] as const;
export type MoneyRequestStatus = (typeof MONEY_REQUEST_STATUSES)[number];

// How paying the request behaves: a group_share (one participant's share of
// a group payment) records no post and takes no visibility.
export const MONEY_REQUEST_KINDS = ['direct', 'group_share'] as const;
export type MoneyRequestKind = (typeof MONEY_REQUEST_KINDS)[number];

const bigintTransformer = {
  to: (v: bigint) => v,
  from: (v: string) => BigInt(v),
};

// See docs/architecture.md §5 and ADR-0012. `requesterUserId`/`payerUserId`/
// `transactionId` are all cross-module references (users, users, ledger's
// transactions respectively) — plain columns, no relation decorators, per
// ADR-0002.
@Entity('money_requests')
@Check('CHK_money_requests_status', inList('status', MONEY_REQUEST_STATUSES))
@Check('CHK_money_requests_kind', inList('kind', MONEY_REQUEST_KINDS))
@Index('IDX_money_requests_payer_user_id_created_at', [
  'payerUserId',
  'createdAt',
])
@Index('IDX_money_requests_requester_user_id_created_at', [
  'requesterUserId',
  'createdAt',
])
@Index(
  'IDX_money_requests_pair_pending',
  ['requesterUserId', 'payerUserId', 'expiresAt'],
  { where: "status = 'pending'" },
)
export class MoneyRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  requesterUserId: string;

  @Column('uuid')
  payerUserId: string;

  @Column('bigint', { transformer: bigintTransformer })
  amount: bigint;

  @Column('varchar')
  currency: string;

  @Column({ type: 'varchar', nullable: true })
  note: string | null;

  // No `expired` value here — see the class-level comment. Expiry is
  // derived from `expiresAt` wherever this status is read.
  @Column('varchar')
  status: MoneyRequestStatus;

  @Column('varchar', { default: 'direct' })
  kind: MoneyRequestKind;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'uuid', nullable: true })
  transactionId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
