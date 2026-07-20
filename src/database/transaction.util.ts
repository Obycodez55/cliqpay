import { DataSource, EntityManager } from 'typeorm';

/**
 * Every money movement gets wrapped in a DB transaction — see
 * docs/architecture.md §7 Data Integrity. Services call this instead of
 * reaching for DataSource.transaction() directly, so commit/rollback
 * behavior stays in exactly one place. Pass whatever DataSource the caller
 * already has (constructor-injected via @InjectDataSource() or plain
 * DataSource, since TypeOrmCoreModule is global) — no DI wiring of its own.
 *
 * Multi-row locking helpers (e.g. the account_id-ascending lock ordering
 * required for concurrent wallet updates — see CLAUDE.md) belong here too,
 * added once the first module that needs them (ledger/P2P transfers)
 * exists — not ahead of that, per CLAUDE.md's "build incrementally" rule.
 */
export function runInTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(work);
}
