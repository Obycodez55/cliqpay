import { DataSourceOptions } from 'typeorm';
import { AppConfig } from '../config';
import { CliqpayNamingStrategy } from './naming-strategy';

/**
 * The one place that defines what a Cliqpay datasource looks like. Both the
 * migration CLI (data-source.ts) and the running app (database.module.ts)
 * build their own DataSource/connection from this — they're separate
 * processes, so they can't share a live instance, only this definition.
 *
 * __dirname here is this file's own directory (src/database in dev via
 * ts-node, dist/database once compiled), so the same relative glob resolves
 * correctly in both contexts without needing two separate path sets.
 */
export function buildDataSourceOptions(
  config: Pick<AppConfig, 'database'>,
): DataSourceOptions {
  return {
    type: 'postgres',
    url: config.database.url,
    entities: [__dirname + '/../modules/**/entities/*.entity{.ts,.js}'],
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    namingStrategy: new CliqpayNamingStrategy(),
    // Migrations only, always — see docs/architecture.md §7 Data Integrity.
    synchronize: false,
  };
}
