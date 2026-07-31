import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { Money } from '../../../shared/primitives/money';
import {
  LedgerEntry,
  LedgerEntryDirection,
} from '../entities/ledger-entry.entity';
import {
  TransactionStatus,
  TransactionType,
} from '../entities/transaction.entity';

export class TransactionHistoryItemDto {
  @ApiProperty({ description: 'Ledger entry id' })
  id: string;

  @ApiProperty()
  reference: string;

  @ApiProperty({
    enum: [
      'funding',
      'p2p_transfer',
      'withdrawal',
      'chargeback',
      'profit_withdrawal',
      'bill_split',
      'scheduled',
    ],
  })
  type: TransactionType;

  @ApiProperty({
    enum: ['pending', 'completed', 'failed', 'reversed', 'disputed'],
  })
  status: TransactionStatus;

  @ApiProperty({ enum: ['debit', 'credit'] })
  direction: LedgerEntryDirection;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiProperty()
  createdAt: string;
}

// `entry.transaction` must be loaded (see LedgerService.getTransactionHistory's
// join) — this reads from ledger_entries joined to transactions, per §5's
// note that ledger_entries is the source of truth for a wallet's activity,
// not the denormalized sender/recipient columns on transactions.
export function toTransactionHistoryItem(
  entry: LedgerEntry,
): TransactionHistoryItemDto {
  return {
    id: entry.id,
    reference: entry.transaction.reference,
    type: entry.transaction.type,
    status: entry.transaction.status,
    direction: entry.direction,
    amount: Money.of(entry.amount, entry.transaction.currency).toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}
