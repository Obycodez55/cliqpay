import 'dotenv/config';
import { DataSource } from 'typeorm';
import {
  RekeyAbortedError,
  formatRekeyReport,
  hasStaleHashes,
  rekeyIdentifierHashes,
} from './rekey-identifier-hashes';
import { buildDataSourceOptions } from './data-source.options';

const HEX_KEY = /^[0-9a-fA-F]{64}$/;

function requireEnv(name: string, pattern?: RegExp): string {
  const value = process.env[name];
  if (!value || (pattern && !pattern.test(value))) {
    throw new Error(
      `${name} is missing or malformed${pattern ? ' (64-character hex expected)' : ''}`,
    );
  }
  return value;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const allowOrphans = args.includes('--allow-orphans');

  const dataSource = new DataSource(
    buildDataSourceOptions({
      database: { url: requireEnv('DATABASE_URL') },
    }),
  );
  const options = {
    encryptionKey: requireEnv('ENCRYPTION_KEY', HEX_KEY),
    identifierHashKey: requireEnv('IDENTIFIER_HASH_KEY', HEX_KEY),
    apply,
    allowOrphans,
  };

  await dataSource.initialize();
  try {
    const report = await rekeyIdentifierHashes(dataSource, options);
    console.log(formatRekeyReport(report));
    return !apply && hasStaleHashes(report) ? 1 : 0;
  } catch (error) {
    if (error instanceof RekeyAbortedError) {
      console.error(`ABORTED: ${error.message}`);
      console.error(formatRekeyReport(error.report));
      return 2;
    }
    throw error;
  } finally {
    await dataSource.destroy();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      error instanceof Error &&
        error.message.includes('is missing or malformed')
        ? error.message
        : `Failed: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
    process.exit(3);
  });
