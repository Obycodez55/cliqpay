import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadConfig } from './src/config';
import { buildDataSourceOptions } from './src/database/data-source.options';

/**
 * CLI-only DataSource, used by the typeorm migration commands (package.json
 * `migration:*` scripts). Lives at repo root, not in src/, because it's
 * tooling that runs via ts-node standalone — it's never imported by
 * application code and never needs to ship in the compiled dist/ output
 * (see tsconfig.build.json's exclude). Runs outside Nest's DI container
 * entirely, so it calls loadConfig() directly rather than injecting
 * APP_CONFIG. The running app gets its connection through
 * TypeOrmModule.forRootAsync in database.module.ts instead — both build
 * from the same buildDataSourceOptions() in
 * src/database/data-source.options.ts.
 */
export const AppDataSource = new DataSource(
  buildDataSourceOptions(loadConfig()),
);
