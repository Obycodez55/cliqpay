import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { IdentitySummaryDto } from '../../../common/dto/identity-summary.dto';
import { Money } from '../../../shared/primitives/money';
import {
  LedgerEntry,
  LedgerEntryDirection,
} from '../entities/ledger-entry.entity';
import {
  TransactionStatus,
  TransactionType,
} from '../entities/transaction.entity';

// Ledger's own view of a history row — `counterpartyUserId` is as far as
// LedgerService goes (accounts is its own table, so resolving a wallet id to
// a user id needs no cross-module import). Resolving that id to a display
// name is WalletController's job, once UsersService is in scope (see
// toTransactionHistoryItem below).
export interface TransactionHistoryEntry {
  id: string;
  reference: string;
  type: TransactionType;
  status: TransactionStatus;
  direction: LedgerEntryDirection;
  amount: Money;
  counterpartyUserId: string | null;
  createdAt: Date;
}

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
      'withdrawal_reversal',
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

  @ApiProperty({
    type: IdentitySummaryDto,
    nullable: true,
    description:
      'The other party to this transaction, or null for transaction types with no counterparty (e.g. funding)',
  })
  counterparty: IdentitySummaryDto | null;

  @ApiProperty()
  createdAt: string;
}

// `entry.transaction` must be loaded (see LedgerService.getTransactionHistory's
// join) — this reads from ledger_entries joined to transactions, per §5's
// note that ledger_entries is the source of truth for a wallet's activity,
// not the denormalized sender/recipient columns on transactions.
//
// `counterpartyUserId` is a legitimate, narrow use of those denormalized
// columns: `p2p_transfer` is the only transaction type today with exactly
// two parties, and it's read here only to find "the wallet that isn't the
// viewer's own" — not as a general participants list (see §5's warning,
// which is about future multi-party types like bill-split).
export function toTransactionHistoryEntry(
  entry: LedgerEntry,
  viewerWalletId: string,
  counterpartyUserIdByWalletId: ReadonlyMap<string, string | null>,
): TransactionHistoryEntry {
  const counterpartyWalletId =
    entry.transaction.type === 'p2p_transfer'
      ? entry.transaction.senderWalletId === viewerWalletId
        ? entry.transaction.recipientWalletId
        : entry.transaction.senderWalletId
      : null;

  return {
    id: entry.id,
    reference: entry.transaction.reference,
    type: entry.transaction.type,
    status: entry.transaction.status,
    direction: entry.direction,
    amount: Money.of(entry.amount, entry.transaction.currency),
    counterpartyUserId: counterpartyWalletId
      ? (counterpartyUserIdByWalletId.get(counterpartyWalletId) ?? null)
      : null,
    createdAt: entry.createdAt,
  };
}

export function toTransactionHistoryItem(
  entry: TransactionHistoryEntry,
  identityByUserId: ReadonlyMap<string, IdentitySummaryDto>,
): TransactionHistoryItemDto {
  return {
    id: entry.id,
    reference: entry.reference,
    type: entry.type,
    status: entry.status,
    direction: entry.direction,
    amount: entry.amount.toJSON(),
    counterparty: entry.counterpartyUserId
      ? (identityByUserId.get(entry.counterpartyUserId) ?? null)
      : null,
    createdAt: entry.createdAt.toISOString(),
  };
}
