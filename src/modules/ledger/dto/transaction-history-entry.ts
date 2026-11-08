import { SCHEDULED_REFERENCE_PREFIX } from '../../../common/validation/reference';
import { Money } from '../../../shared/primitives/money';
import {
  LedgerEntry,
  LedgerEntryDirection,
} from '../entities/ledger-entry.entity';
import {
  Transaction,
  TransactionStatus,
  TransferTransactionMetadata,
  TransactionType,
} from '../entities/transaction.entity';

// Ledger's own view of a history row — `counterpartyUserId` is as far as
// LedgerService goes (accounts is its own table, so resolving a wallet id to
// a user id needs no cross-module import). Resolving that id to a display
// name is the caller's job.
export interface TransactionHistoryEntry {
  id: string;
  transactionId: string | null;
  // Null when a scheduled payment's reference would tell the recipient the
  // payment was scheduled.
  reference: string | null;
  type: TransactionType;
  status: TransactionStatus;
  // Null for a funding held or refunded: the wallet was never
  // credited, so there is no entry to take a direction from.
  direction: LedgerEntryDirection | null;
  amount: Money;
  counterpartyUserId: string | null;
  note: string | null;
  createdAt: Date;
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

  const hideReference =
    entry.transaction.type === 'p2p_transfer' &&
    entry.transaction.senderWalletId !== viewerWalletId &&
    entry.transaction.reference
      .toLowerCase()
      .startsWith(SCHEDULED_REFERENCE_PREFIX);

  return {
    id: entry.id,
    transactionId:
      entry.transaction.type === 'p2p_transfer' ? entry.transaction.id : null,
    reference: hideReference ? null : entry.transaction.reference,
    type: entry.transaction.type,
    status: entry.transaction.status,
    direction: entry.direction,
    amount: Money.of(entry.amount, entry.transaction.currency),
    counterpartyUserId: counterpartyWalletId
      ? (counterpartyUserIdByWalletId.get(counterpartyWalletId) ?? null)
      : null,
    note:
      entry.transaction.type === 'p2p_transfer'
        ? ((entry.transaction.metadata as TransferTransactionMetadata).note ??
          null)
        : null,
    createdAt: entry.createdAt,
  };
}

// A funding held or refunded has no entry on the wallet: the money went to
// suspense, never the wallet. `createdAt` is when it was held, matching where
// it sits in the history.
export function toHeldFundingHistoryEntry(
  funding: Transaction,
  heldAt: Date,
): TransactionHistoryEntry {
  return {
    id: funding.id,
    transactionId: null,
    reference: funding.reference,
    type: funding.type,
    status: funding.status,
    direction: null,
    amount: Money.of(funding.amount, funding.currency),
    counterpartyUserId: null,
    note: null,
    createdAt: heldAt,
  };
}
