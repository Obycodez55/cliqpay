import { TransactionProvider } from '../../ledger/ledger.service';

export interface ActiveReconciliationPair {
  provider: TransactionProvider;
  currency: string;
}

// The only active (provider, currency) pair today — matches funding's
// NGN-only scope (see PaymentsService.fundWallet). Adding a second provider
// or currency later is appending to this array, not restructuring the
// reconciliation job (CLAUDE.md's incremental-build rule — no config-driven
// registry until something else needs one).
export const ACTIVE_RECONCILIATION_PAIRS: ActiveReconciliationPair[] = [
  { provider: 'kora', currency: 'NGN' },
];
