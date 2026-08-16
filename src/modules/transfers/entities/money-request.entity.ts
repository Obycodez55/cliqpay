import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MoneyRequestStatus = 'pending' | 'paid' | 'declined' | 'cancelled';

const bigintTransformer = {
  to: (v: bigint) => v,
  from: (v: string) => BigInt(v),
};

// See docs/architecture.md §5 and ADR-0012. `requesterUserId`/`payerUserId`/
// `transactionId` are all cross-module references (users, users, ledger's
// transactions respectively) — plain columns, no relation decorators, per
// ADR-0002.
@Entity('money_requests')
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

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'uuid', nullable: true })
  transactionId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
