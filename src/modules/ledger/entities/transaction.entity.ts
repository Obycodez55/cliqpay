import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Account } from './account.entity';

export type TransactionProvider = 'kora';
export type TransactionType =
  | 'funding'
  | 'p2p_transfer'
  | 'withdrawal'
  | 'chargeback'
  | 'profit_withdrawal'
  | 'bill_split'
  | 'scheduled';
export type TransactionStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'reversed'
  | 'disputed';

const bigintTransformer = {
  to: (v: bigint) => v,
  from: (v: string) => BigInt(v),
};

export interface FundingTransactionMetadata {
  // The provider's hosted checkout page for this attempt. Kept so a retry
  // carrying an already-seen `reference` can return the same URL without a
  // second call out to the provider (see PaymentsService.fundWallet). Null
  // between the row being inserted and the provider call actually
  // returning — the row is created first specifically so the unique
  // constraint on `reference` gates the provider call itself, not just our
  // own bookkeeping (see PaymentsService.fundWallet).
  checkoutUrl: string | null;
  // What the customer actually paid (net + provider fee) — §4.2 specifies
  // this as part of funding metadata; `amount`/`ledger_entries` only carry
  // the net (credited) side, so without this nothing records the gross
  // figure. Set once, at completion (LedgerService.postFunding) — null
  // until then, same as checkoutUrl before initiation returns.
  grossAmount: { amount: string; currency: string } | null;
}

/**
 * Metadata is shaped per transaction type, not a free-form bag — `payments`
 * writing an untyped field here and casting it back on read is exactly the
 * leak ADR-0008 rules out. Only `funding` exists so far; each further type
 * adds its own shape (making this a union) when that type is built.
 */
export type TransactionMetadata = FundingTransactionMetadata;

/**
 * See docs/architecture.md §5. `sender_wallet_id`/`recipient_wallet_id` are
 * a denormalized convenience, not the source of truth for participants
 * (that's `ledger_entries` joined to `accounts`) — see the schema note.
 *
 * `IDX_transactions_stale_funding_poll` (below) backs
 * LedgerService.findStaleFundingTransactions, which runs every 5 minutes
 * (the poll job, issue #14) — without it, that query seq-scans this table,
 * the one guaranteed to grow without bound. See
 * `AddFundingQueryIndexes1785488695081` for the real definition.
 */
@Entity('transactions')
@Index('IDX_transactions_stale_funding_poll', [
  'status',
  'provider',
  'type',
  'createdAt',
])
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  reference: string;

  @Column({ type: 'varchar', nullable: true })
  provider: TransactionProvider | null;

  @Index()
  @Column({ type: 'varchar', nullable: true })
  providerReference: string | null;

  @Column('varchar')
  type: TransactionType;

  @Column('varchar')
  status: TransactionStatus;

  @Column({ type: 'uuid', nullable: true })
  reversesTransactionId: string | null;

  @ManyToOne(() => Transaction, { nullable: true })
  @JoinColumn({ name: 'reverses_transaction_id' })
  reversesTransaction: Transaction | null;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column('varchar')
  currency: string;

  @Column({ type: 'uuid', nullable: true })
  senderWalletId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'sender_wallet_id' })
  senderWallet: Account | null;

  @Column({ type: 'uuid', nullable: true })
  recipientWalletId: string | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'recipient_wallet_id' })
  recipientWallet: Account | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: TransactionMetadata;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
