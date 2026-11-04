import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../../src/database/data-source.options';
import {
  ADMIN_URL_ENV,
  TEMPLATE_DATABASE,
  databaseUrl,
  withAdminConnection,
} from './test-database';

export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  globalThis.__CLIQPAY_TEST_PG__ = container;

  // Jest skips globalTeardown when interrupted, and Ryuk is off in CI.
  const stopOnSignal = (signal: NodeJS.Signals, code: number) =>
    process.once(signal, () => {
      void container.stop().finally(() => process.exit(code));
    });
  stopOnSignal('SIGINT', 130);
  stopOnSignal('SIGTERM', 143);

  process.env[ADMIN_URL_ENV] = container.getConnectionUri();

  await withAdminConnection((admin) =>
    admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`),
  );

  const dataSource = new DataSource(
    buildDataSourceOptions({
      database: { url: databaseUrl(TEMPLATE_DATABASE) },
    }),
  );
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();

  // Not connectable, so a clone never races a stray session on the source.
  await withAdminConnection((admin) =>
    admin.query(
      `ALTER DATABASE ${TEMPLATE_DATABASE} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    ),
  );
}
