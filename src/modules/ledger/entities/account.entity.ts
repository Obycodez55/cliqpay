import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const ACCOUNT_TYPES = [
  'asset',
  'liability',
  'equity',
  'expense',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const ACCOUNT_ROLES = [
  'float',
  'fee_income',
  'fee_expense',
  'fee_recovery',
  'suspense',
  'user_wallet',
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/**
 * See docs/architecture.md §5 — `user_id` is null for system accounts
 * (float/fee_*), non-null for a user's own wallet. No FK to `users`: that
 * table belongs to the `auth` module, this one to `ledger` — cross-module
 * references stay plain UUIDs (CLAUDE.md, "Module structure").
 *
 * `UQ_accounts_system` is declared without `NULLS NOT DISTINCT`: `IndexOptions`
 * has no field for it and the schema diff cannot see it, so the clause lives
 * only in the `CreateUsersAndAccounts` migration.
 */
@Entity('accounts')
@Check('CHK_accounts_provider', `"provider" = 'kora'`)
@Check('CHK_accounts_type', inList('type', ACCOUNT_TYPES))
@Check('CHK_accounts_role', inList('role', ACCOUNT_ROLES))
@Index('IDX_accounts_user_id', ['userId'])
@Index('UQ_accounts_system', ['role', 'provider', 'currency'], {
  unique: true,
  where: `"user_id" IS NULL`,
})
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
