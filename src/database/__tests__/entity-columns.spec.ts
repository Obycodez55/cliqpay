import { DataSource, EntityMetadata } from 'typeorm';
import { buildDataSourceOptions } from '../data-source.options';

// Pure relationship tables keyed on the pair itself, where a surrogate id
// would only add a second uniqueness rule to keep in step with the first.
const COMPOSITE_KEY_TABLES = new Set([
  'follows',
  'blocks',
  'post_reactions',
  'post_participants',
]);

// A post's id is its subject's id (the transaction id for a transfer post),
// so a second post per subject can't exist and nothing generates it.
const SUBJECT_KEYED_TABLES = new Set(['posts']);

// Copies the post's own creation time (post_created_at) so the feed reads one
// index; it has no timestamps of its own.
const SNAPSHOT_TIMESTAMP_TABLES = new Set(['post_participants']);

// Events are never updated, so the only timestamp is when they occurred.
const OCCURRED_AT_TABLES = new Set(['audit_events']);

describe('entity base columns', () => {
  let metadatas: EntityMetadata[];

  beforeAll(async () => {
    const dataSource = new DataSource({
      ...buildDataSourceOptions({ database: { url: 'postgres://unused' } }),
      migrations: [],
    });
    // buildMetadatas() resolves entity metadata without opening a connection.
    await (
      dataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
    metadatas = dataSource.entityMetadatas;
  });

  it('every entity has a generated uuid primary key and timestamptz timestamps', () => {
    expect(metadatas.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const metadata of metadatas) {
      const table = metadata.tableName;
      const id = metadata.findColumnWithPropertyName('id');
      const createdAt = metadata.findColumnWithPropertyName('createdAt');
      const updatedAt = metadata.findColumnWithPropertyName('updatedAt');

      if (COMPOSITE_KEY_TABLES.has(table)) {
        if (metadata.primaryColumns.length < 2 || id) {
          violations.push(`${table} should have a composite primary key`);
        }
      } else if (SUBJECT_KEYED_TABLES.has(table)) {
        if (
          metadata.primaryColumns.length !== 1 ||
          metadata.primaryColumns[0] !== id ||
          id?.type !== 'uuid' ||
          id.generationStrategy
        ) {
          violations.push(
            `${table}.id is not a non-generated uuid primary key`,
          );
        }
      } else if (
        metadata.primaryColumns.length !== 1 ||
        metadata.primaryColumns[0] !== id ||
        id?.type !== 'uuid' ||
        id.generationStrategy !== 'uuid'
      ) {
        violations.push(`${table}.id is not a generated uuid primary key`);
      }
      if (SNAPSHOT_TIMESTAMP_TABLES.has(table)) {
        continue;
      }
      if (OCCURRED_AT_TABLES.has(table)) {
        const occurredAt = metadata.findColumnWithPropertyName('occurredAt');
        if (occurredAt?.type !== 'timestamptz' || !occurredAt.isCreateDate) {
          violations.push(
            `${table}.occurredAt is not a timestamptz create-date`,
          );
        }
        continue;
      }
      if (createdAt?.type !== 'timestamptz' || !createdAt.isCreateDate) {
        violations.push(`${table}.createdAt is not a timestamptz create-date`);
      }
      if (
        updatedAt &&
        (updatedAt.type !== 'timestamptz' || !updatedAt.isUpdateDate)
      ) {
        violations.push(`${table}.updatedAt is not a timestamptz update-date`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('ledger_entries stays append-only (no updatedAt)', () => {
    const ledgerEntries = metadatas.find(
      (m) => m.tableName === 'ledger_entries',
    );
    expect(ledgerEntries).toBeDefined();
    expect(
      ledgerEntries!.findColumnWithPropertyName('updatedAt'),
    ).toBeUndefined();
  });
});
