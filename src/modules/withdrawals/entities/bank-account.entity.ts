import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// See docs/architecture.md §5 and ADR-0014. `userId` is a cross-module
// reference into `users` — plain column, no relation decorator (ADR-0002).
//
// `accountNumber` is encrypted at rest (§7) — recoverable via
// decryptSecret, never stored in plaintext. The unique constraint can't be
// enforced against the ciphertext (a fresh IV makes every encryption of the
// same value distinct), so `accountNumberHash` — a deterministic, keyed
// HMAC of the plaintext — carries the uniqueness check instead. It's a
// one-way lookup value only, never decrypted or decryptable.
@Entity('bank_accounts')
@Unique('UQ_bank_accounts_user_provider_bank_account_hash', [
  'userId',
  'provider',
  'bankCode',
  'accountNumberHash',
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

  @Column('varchar', { name: 'account_number_ciphertext' })
  accountNumberCiphertext: string;

  @Column('varchar', { name: 'account_number_hash' })
  accountNumberHash: string;

  // Provider-resolved at save time — see WithdrawalsService.saveBankAccount.
  // Never client-supplied.
  @Column('varchar')
  accountName: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
