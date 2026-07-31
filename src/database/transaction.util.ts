import { DataSource, EntityManager } from 'typeorm';

/**
 * Every money movement gets wrapped in a DB transaction — see
 * docs/architecture.md §7 Data Integrity. Services call this instead of
 * reaching for DataSource.transaction() directly, so commit/rollback
 * behavior stays in exactly one place. Pass whatever DataSource the caller
 * already has (constructor-injected via @InjectDataSource() or plain
 * DataSource, since TypeOrmCoreModule is global) — no DI wiring of its own.
 *
 * The account_id-ascending lock ordering CLAUDE.md requires for concurrent
 * wallet updates lives inline where it's used (LedgerService.postFunding),
 * not as a shared helper here — the query shape (which roles/accounts get
 * locked) is specific to each posting method, so there wasn't a common
 * helper to extract yet. Revisit if a second locking call site (P2P
 * transfers) turns out to share enough shape with this one to be worth it.
 */
export function runInTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(work);
}
