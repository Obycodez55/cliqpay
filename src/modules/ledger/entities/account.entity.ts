import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AccountType = 'asset' | 'liability' | 'equity' | 'expense';
export type AccountRole =
  | 'float'
  | 'fee_income'
  | 'fee_expense'
  | 'fee_recovery'
  | 'user_wallet';

/**
 * See docs/architecture.md §5 — `user_id` is null for system accounts
 * (float/fee_*), non-null for a user's own wallet. No FK to `users`: that
 * table belongs to the `auth` module, this one to `ledger` — cross-module
 * references stay plain UUIDs (CLAUDE.md, "Module structure").
 *
 * `UQ_accounts_system` (the system-account identity index, keyed on
 * role/provider/currency where user_id is null) is deliberately not
 * mirrored here — it relies on Postgres 15's `NULLS NOT DISTINCT`, which
 * TypeORM's `IndexOptions` has no field for. Declaring it via `@Index`
 * without that clause would describe a different, subtly wrong index. See
 * the `CreateUsersAndAccounts` migration for the real definition.
 */
@Entity('accounts')
@Index('UQ_accounts_user_wallet', ['userId', 'currency'], {
  unique: true,
  where: `"role" = 'user_wallet'`,
})
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column('varchar')
  type: AccountType;

  @Column('varchar')
  role: AccountRole;

  @Column({ type: 'varchar', nullable: true })
  provider: string | null;

  @Column('varchar')
  currency: string;

  @Column({
    type: 'bigint',
    default: 0,
    transformer: { to: (v: bigint) => v, from: (v: string) => BigInt(v) },
  })
  balance: bigint;

  @CreateDateColumn()
  createdAt: Date;
}
