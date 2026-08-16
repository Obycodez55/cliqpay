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

export function toBankAccountResponse(
  bankAccount: BankAccount,
): BankAccountResponseDto {
  return {
    id: bankAccount.id,
    bankCode: bankAccount.bankCode,
    bankName: bankAccount.bankName,
    accountNumber: bankAccount.accountNumber,
    accountName: bankAccount.accountName,
    createdAt: bankAccount.createdAt,
  };
}
