import { DataSource } from 'typeorm';
import {
  decryptSecret,
  encryptSecret,
  encryptionKeyFromHex,
} from '../shared/crypto/secrets.util';

export interface RotateOptions {
  oldKey: string;
  newKey: string;
  apply: boolean;
}

export interface RotateColumnReport {
  scanned: number;
  rotate: number;
  alreadyRotated: number;
  undecryptableIds: string[];
}

export interface RotateReport {
  applied: boolean;
  columns: Record<string, RotateColumnReport>;
}

export class RotateAbortedError extends Error {
  constructor(
    message: string,
    readonly report: RotateReport,
  ) {
    super(message);
    this.name = 'RotateAbortedError';
  }
}

export interface CiphertextColumn {
  table: string;
  column: string;
}

export const CIPHERTEXT_COLUMNS: CiphertextColumn[] = [
  { table: 'mfa_methods', column: 'secret_ciphertext' },
  { table: 'bank_accounts', column: 'account_number_ciphertext' },
  { table: 'kyc_verifications', column: 'bvn_ciphertext' },
  { table: 'kyc_verifications', column: 'nin_ciphertext' },
];

export const columnLabel = (c: CiphertextColumn) => `${c.table}.${c.column}`;

function tryDecrypt(ciphertext: string, key: Buffer): string | null {
  try {
    return decryptSecret(ciphertext, key);
  } catch {
    return null;
  }
}

export async function rotateEncryptionKey(
  dataSource: DataSource,
  options: RotateOptions,
): Promise<RotateReport> {
  if (options.oldKey.toLowerCase() === options.newKey.toLowerCase()) {
    throw new Error('NEW_ENCRYPTION_KEY must differ from OLD_ENCRYPTION_KEY');
  }
  const oldKey = encryptionKeyFromHex(options.oldKey);
  const newKey = encryptionKeyFromHex(options.newKey);

  return dataSource.transaction(async (manager) => {
    const report: RotateReport = { applied: false, columns: {} };
    const pending: { target: CiphertextColumn; updates: [string, string][] }[] =
      [];

    for (const target of CIPHERTEXT_COLUMNS) {
      const rows: { id: string; ciphertext: string }[] = await manager.query(
        `SELECT id, ${target.column} AS ciphertext FROM ${target.table}
         WHERE ${target.column} IS NOT NULL ORDER BY id`,
      );
      const columnReport: RotateColumnReport = {
        scanned: rows.length,
        rotate: 0,
        alreadyRotated: 0,
        undecryptableIds: [],
      };
      const updates: [string, string][] = [];
      for (const row of rows) {
        const plaintext = tryDecrypt(row.ciphertext, oldKey);
        if (plaintext !== null) {
          updates.push([row.id, encryptSecret(plaintext, newKey)]);
          columnReport.rotate += 1;
        } else if (tryDecrypt(row.ciphertext, newKey) !== null) {
          columnReport.alreadyRotated += 1;
        } else {
          columnReport.undecryptableIds.push(row.id);
        }
      }
      report.columns[columnLabel(target)] = columnReport;
      pending.push({ target, updates });
    }

    if (
      Object.values(report.columns).some((c) => c.undecryptableIds.length > 0)
    ) {
      throw new RotateAbortedError(
        'Some ciphertext decrypts with neither key; nothing written',
        report,
      );
    }

    if (options.apply) {
      for (const { target, updates } of pending) {
        for (const [id, ciphertext] of updates) {
          await manager.query(
            `UPDATE ${target.table} SET ${target.column} = $1 WHERE id = $2`,
            [ciphertext, id],
          );
        }
      }
      report.applied = true;
    }
    return report;
  });
}

export function formatRotateReport(report: RotateReport): string {
  const lines = [report.applied ? 'APPLIED' : 'DRY RUN (nothing written)'];
  for (const [label, c] of Object.entries(report.columns)) {
    lines.push(
      `${label}: scanned=${c.scanned} to_rotate=${c.rotate} already_rotated=${c.alreadyRotated} undecryptable=${c.undecryptableIds.length}`,
    );
    if (c.undecryptableIds.length > 0) {
      lines.push(`  UNDECRYPTABLE ROW IDS: ${c.undecryptableIds.join(', ')}`);
    }
  }
  return lines.join('\n');
}

export function hasPendingRotation(report: RotateReport): boolean {
  return Object.values(report.columns).some((c) => c.rotate > 0);
}
