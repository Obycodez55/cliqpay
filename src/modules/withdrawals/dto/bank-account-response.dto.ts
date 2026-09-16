import { ApiProperty } from '@nestjs/swagger';
import { BankAccount } from '../entities/bank-account.entity';

export class BankAccountResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: '033' })
  bankCode: string;

  @ApiProperty({ example: 'United Bank for Africa' })
  bankName: string;

  @ApiProperty({ example: '0000000000' })
  accountNumber: string;

  @ApiProperty({ example: 'Jane Doe' })
  accountName: string;

  @ApiProperty()
  createdAt: Date;
}

// `accountNumber` is passed in decrypted — the entity only ever holds the
// ciphertext (docs/architecture.md §7), so the caller (which already has
// the encryption key) is what decrypts it.
export function toBankAccountResponse(
  bankAccount: BankAccount,
  accountNumber: string,
): BankAccountResponseDto {
  return {
    id: bankAccount.id,
    bankCode: bankAccount.bankCode,
    bankName: bankAccount.bankName,
    accountNumber,
    accountName: bankAccount.accountName,
    createdAt: bankAccount.createdAt,
  };
}
