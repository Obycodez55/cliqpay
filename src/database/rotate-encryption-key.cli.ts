import 'dotenv/config';
import { DataSource } from 'typeorm';
import {
  RotateAbortedError,
  formatRotateReport,
  hasPendingRotation,
  rotateEncryptionKey,
} from './rotate-encryption-key';
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
  const apply = process.argv.slice(2).includes('--apply');

  const dataSource = new DataSource(
    buildDataSourceOptions({
      database: { url: requireEnv('DATABASE_URL') },
    }),
  );
  const options = {
    oldKey: requireEnv('OLD_ENCRYPTION_KEY', HEX_KEY),
    newKey: requireEnv('NEW_ENCRYPTION_KEY', HEX_KEY),
    apply,
  };

  await dataSource.initialize();
  try {
    const report = await rotateEncryptionKey(dataSource, options);
    console.log(formatRotateReport(report));
    return !apply && hasPendingRotation(report) ? 1 : 0;
  } catch (error) {
    if (error instanceof RotateAbortedError) {
      console.error(`ABORTED: ${error.message}`);
      console.error(formatRotateReport(error.report));
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
        (error.message.includes('is missing or malformed') ||
          error.message.includes('must differ'))
        ? error.message
        : `Failed: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
    process.exit(3);
  });
