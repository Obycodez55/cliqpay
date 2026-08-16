import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// See docs/architecture.md §5 and ADR-0014. `userId` is a cross-module
// reference into `users` — plain column, no relation decorator (ADR-0002).
@Entity('bank_accounts')
@Unique('UQ_bank_accounts_user_provider_bank_account', [
  'userId',
  'provider',
  'bankCode',
  'accountNumber',
])
export class BankAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column('varchar')
  provider: string;

  @Column('varchar')
  bankCode: string;

  @Column('varchar')
  bankName: string;

  @Column('varchar')
  accountNumber: string;

  // Provider-resolved at save time — see WithdrawalsService.saveBankAccount.
  // Never client-supplied.
  @Column('varchar')
  accountName: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
