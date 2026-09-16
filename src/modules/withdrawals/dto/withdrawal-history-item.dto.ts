import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { WithdrawalHistoryEntry } from '../../ledger/ledger.service';

export class WithdrawalHistoryBankAccountDto {
  @ApiProperty({ example: '033' })
  bankCode: string;

  @ApiProperty({ example: 'United Bank for Africa' })
  bankName: string;

  @ApiProperty({ example: '0000000000' })
  accountNumber: string;

  @ApiProperty({ example: 'Jane Doe' })
  accountName: string;
}

export class WithdrawalHistoryItemDto {
  @ApiProperty()
  reference: string;

  @ApiProperty({ enum: ['pending', 'completed', 'reversed'] })
  status: 'pending' | 'completed' | 'reversed';

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  platformFee: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  providerFee: MoneyDto;

  @ApiProperty({ type: WithdrawalHistoryBankAccountDto })
  bankAccount: WithdrawalHistoryBankAccountDto;

  @ApiProperty()
  createdAt: string;
}

// `status` is narrowed from ledger's full TransactionStatus — a `type:
// 'withdrawal'` row can only ever be 'pending', 'completed', or 'reversed'
// (see postWithdrawal/completeWithdrawal/reverseWithdrawal in
// LedgerService); 'failed'/'disputed' belong to other transaction types.
export function toWithdrawalHistoryItem(
  entry: WithdrawalHistoryEntry,
): WithdrawalHistoryItemDto {
  return {
    reference: entry.reference,
    status: entry.status as 'pending' | 'completed' | 'reversed',
    amount: entry.amount.toJSON(),
    platformFee: entry.metadata.platformFee,
    providerFee: entry.metadata.providerFee,
    bankAccount: {
      bankCode: entry.metadata.bankAccount.bankCode,
      bankName: entry.metadata.bankAccount.bankName,
      accountNumber: entry.metadata.bankAccount.accountNumber,
      accountName: entry.metadata.bankAccount.accountName,
    },
    createdAt: entry.createdAt.toISOString(),
  };
}
