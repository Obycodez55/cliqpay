import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';
import { TransactionHistoryEntry } from '../../ledger/ledger.service';

export class TransactionHistoryItemDto {
  @ApiProperty({ description: 'Ledger entry id' })
  id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The transaction id for a P2P transfer — the same id on both sides, and the key for /social/posts/{transactionId}, except that a transfer paying a group-share money request (one share of a bill split) has no post. Null for every other type.',
  })
  transactionId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The transaction reference. Null on the recipient side of a P2P transfer whose reference is reserved for system use.',
  })
  reference: string | null;

  @ApiProperty({
    enum: [
      'funding',
      'p2p_transfer',
      'withdrawal',
      'withdrawal_reversal',
      'chargeback',
      'profit_withdrawal',
      'bill_split',
      'scheduled',
    ],
  })
  type: TransactionHistoryEntry['type'];

  @ApiProperty({
    enum: [
      'pending',
      'completed',
      'failed',
      'reversed',
      'disputed',
      'held',
      'refunded',
    ],
  })
  status: TransactionHistoryEntry['status'];

  @ApiProperty({
    enum: ['debit', 'credit'],
    nullable: true,
    description:
      'The effect on the wallet, or null when the wallet was not touched: a funding held in suspense, or already refunded, because it would have taken the wallet over its balance limit.',
  })
  direction: TransactionHistoryEntry['direction'];

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiProperty({
    type: IdentitySummaryDto,
    nullable: true,
    description:
      'The other party to this transaction, or null for transaction types with no counterparty (e.g. funding)',
  })
  counterparty: IdentitySummaryDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The note attached to a P2P transfer, or null',
  })
  note: string | null;

  @ApiProperty()
  createdAt: string;
}

export function toTransactionHistoryItem(
  entry: TransactionHistoryEntry,
  identityByUserId: ReadonlyMap<string, IdentitySummaryDto>,
): TransactionHistoryItemDto {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    reference: entry.reference,
    type: entry.type,
    status: entry.status,
    direction: entry.direction,
    amount: entry.amount.toJSON(),
    counterparty: entry.counterpartyUserId
      ? (identityByUserId.get(entry.counterpartyUserId) ?? null)
      : null,
    note: entry.note,
    createdAt: entry.createdAt.toISOString(),
  };
}
