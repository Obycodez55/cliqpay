import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

// Proves the integration layer itself works — a real Postgres in a real
// container, not a mock — per docs/architecture.md §10. Feature modules add
// their own integration specs here once they exist; this one has nothing to
// do with any module, it exists only to prove the harness is wired up.
describe('Testcontainers Postgres harness', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await container?.stop();
  });

  it('connects to a real Postgres instance and runs a query', async () => {
    const result = await dataSource.query<{ sum: number }[]>(
      'SELECT 1 + 1 AS sum',
    );
    expect(result[0].sum).toBe(2);
  });

  it('persists a write within a transaction and reads it back', async () => {
    await dataSource.transaction(async (manager) => {
      await manager.query(
        'CREATE TABLE probe (id SERIAL PRIMARY KEY, value TEXT)',
      );
      await manager.query('INSERT INTO probe (value) VALUES ($1)', [
        'integration-layer-works',
      ]);
    });

    const rows = await dataSource.query<{ value: string }[]>(
      'SELECT value FROM probe',
    );
    expect(rows).toEqual([{ value: 'integration-layer-works' }]);
  });
});
