import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Account } from './account.entity';
import { Transaction } from './transaction.entity';

export type LedgerEntryDirection = 'debit' | 'credit';

/**
 * Append-only — see docs/architecture.md §5, §7 Data Integrity. No
 * `updated_at`: a row here is never updated or deleted, only ever inserted.
 * Not written to until issue #13 (funding posting) — this table exists from
 * this migration onward since it's needed immediately next, but nothing in
 * issue #12 creates a row here.
 */
@Entity('ledger_entries')
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  transactionId: string;

  @ManyToOne(() => Transaction)
  @JoinColumn({ name: 'transaction_id' })
  transaction: Transaction;

  @Index()
  @Column('uuid')
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'account_id' })
  account: Account;

  @Column('varchar')
  direction: LedgerEntryDirection;

  @Column({
    type: 'bigint',
    transformer: { to: (v: bigint) => v, from: (v: string) => BigInt(v) },
  })
  amount: bigint;

  @Column({
    type: 'bigint',
    transformer: { to: (v: bigint) => v, from: (v: string) => BigInt(v) },
  })
  runningBalance: bigint;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
