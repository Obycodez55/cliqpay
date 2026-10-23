import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../data-source.options';
import { CIPHERTEXT_COLUMNS, columnLabel } from '../rotate-encryption-key';

const SRC = join(__dirname, '..', '..');

// Every file that calls encryptSecret, mapped to the persisted columns it writes.
const ENCRYPTING_FILES: Record<string, string[]> = {
  'modules/auth/mfa.service.ts': ['mfa_methods.secret_ciphertext'],
  'modules/kyc/kyc.service.ts': [
    'kyc_verifications.bvn_ciphertext',
    'kyc_verifications.nin_ciphertext',
  ],
  'modules/withdrawals/withdrawals.service.ts': [
    'bank_accounts.account_number_ciphertext',
  ],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('ciphertext column inventory for key rotation', () => {
  const registered = CIPHERTEXT_COLUMNS.map(columnLabel);

  it('lists every file that calls encryptSecret and registers the columns it writes', () => {
    const callers = sourceFiles(SRC)
      .filter((file) => /\bencryptSecret\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
      .filter((file) => !file.startsWith('shared/crypto/'))
      .filter((file) => !file.startsWith('database/rotate-encryption-key'))
      .sort();

    expect(callers).toEqual(Object.keys(ENCRYPTING_FILES).sort());
    const covered = Object.values(ENCRYPTING_FILES).flat().sort();
    expect(covered).toEqual([...registered].sort());
  });

  it('registers every entity column that stores ciphertext', async () => {
    const dataSource = new DataSource({
      ...buildDataSourceOptions({ database: { url: 'postgres://unused' } }),
      migrations: [],
    });
    await (
      dataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();

    const ciphertextColumns = dataSource.entityMetadatas.flatMap((metadata) =>
      metadata.columns
        .filter((column) => column.databaseName.endsWith('_ciphertext'))
        .map((column) => `${metadata.tableName}.${column.databaseName}`),
    );

    expect(ciphertextColumns.length).toBeGreaterThan(0);
    expect([...ciphertextColumns].sort()).toEqual([...registered].sort());
  });
});
