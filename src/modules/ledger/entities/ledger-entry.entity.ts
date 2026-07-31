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
 *
 * `IDX_ledger_entries_account_id_created_at_id` (below) backs
 * LedgerService.getTransactionHistory's cursor query. Declared here for
 * documentation/query-builder purposes; the actual index is DESC on
 * `created_at`/`id` (matching that query's sort), which TypeORM's `@Index`
 * decorator has no way to express — see
 * `AddFundingQueryIndexes1785488695081` for the real definition, same
 * decorator-can't-express-it gap as `UQ_accounts_system` in account.entity.ts.
 */
@Entity('ledger_entries')
@Index('IDX_ledger_entries_account_id_created_at_id', [
  'accountId',
  'createdAt',
  'id',
])
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
