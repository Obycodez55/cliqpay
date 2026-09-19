import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type DisputeStatus = 'open' | 'resolved' | 'upheld';

const bigintTransformer = {
  to: (v: bigint) => v,
  from: (v: string) => BigInt(v),
};

/**
 * See docs/architecture.md §5 and ADR-0016. `chargebackTransactionId` is a
 * cross-module reference into `ledger`'s `transactions` — no FK, no
 * relation decorator (CLAUDE.md's cross-module-reference rule). `userId` is
 * deliberately not stored — derivable via chargebackTransactionId ->
 * accounts.userId, same reasoning as sender/recipientWalletId being
 * denormalized-not-authoritative on `transactions` itself.
 */
@Entity('disputes')
@Index('IDX_disputes_chargeback_transaction_id', ['chargebackTransactionId'])
export class Dispute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  chargebackTransactionId: string;

  @Column({ type: 'varchar', unique: true })
  disputeReference: string;

  @Column('varchar')
  status: DisputeStatus;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column('varchar')
  currency: string;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
