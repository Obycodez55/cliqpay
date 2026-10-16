import { DataSource, EntityMetadata } from 'typeorm';
import { buildDataSourceOptions } from '../data-source.options';

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

      if (
        metadata.primaryColumns.length !== 1 ||
        metadata.primaryColumns[0] !== id ||
        id?.type !== 'uuid' ||
        id.generationStrategy !== 'uuid'
      ) {
        violations.push(`${table}.id is not a generated uuid primary key`);
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
