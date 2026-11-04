import { DataSource, EntityManager } from 'typeorm';
import {
  decryptSecret,
  encryptionKeyFromHex,
  hmacHex,
} from '../shared/crypto/secrets.util';

export interface RekeyOptions {
  encryptionKey: string;
  identifierHashKey: string;
  apply: boolean;
  allowOrphans: boolean;
}

export interface RekeyTableReport {
  scanned: number;
  stale: number;
  orphanIds: string[];
  undecryptableIds: string[];
  conflictIds: string[];
}

export interface RekeyReport {
  applied: boolean;
  tables: Record<string, RekeyTableReport>;
}

export class RekeyAbortedError extends Error {
  constructor(
    message: string,
    readonly report: RekeyReport,
  ) {
    super(message);
    this.name = 'RekeyAbortedError';
  }
}

interface IdentifierColumn {
  table: string;
  label: string;
  ciphertext: string;
  hash: string;
  // Rows sharing this scope would violate the table's unique index if they
  // ended up with the same hash.
  scope: string[];
}

const COLUMNS: IdentifierColumn[] = [
  {
    table: 'kyc_verifications',
    label: 'kyc_verifications.bvn',
    ciphertext: 'bvn_ciphertext',
    hash: 'bvn_hash',
    scope: [],
  },
  {
    table: 'kyc_verifications',
    label: 'kyc_verifications.nin',
    ciphertext: 'nin_ciphertext',
    hash: 'nin_hash',
    scope: [],
  },
  {
    table: 'bank_accounts',
    label: 'bank_accounts.account_number',
    ciphertext: 'account_number_ciphertext',
    hash: 'account_number_hash',
    scope: ['user_id', 'provider', 'bank_code'],
  },
];

type Row = Record<string, string | null> & { id: string };

async function rekeyColumn(
  manager: EntityManager,
  column: IdentifierColumn,
  encryptionKey: Buffer,
  hashKey: Buffer,
): Promise<{ report: RekeyTableReport; updates: [string, string][] }> {
  const scopeSelect = column.scope.map((c) => `, ${c}`).join('');
  const rows: Row[] = await manager.query(
    `SELECT id, ${column.ciphertext}, ${column.hash}${scopeSelect}
     FROM ${column.table} WHERE ${column.hash} IS NOT NULL ORDER BY id`,
  );
  const report: RekeyTableReport = {
    scanned: rows.length,
    stale: 0,
    orphanIds: [],
    undecryptableIds: [],
    conflictIds: [],
  };
  const updates: [string, string][] = [];
  const owners = new Map<string, string>();
  for (const row of rows) {
    const ciphertext = row[column.ciphertext];
    if (!ciphertext) {
      report.orphanIds.push(row.id);
      continue;
    }
    let newHash: string;
    try {
      newHash = hmacHex(decryptSecret(ciphertext, encryptionKey), hashKey);
    } catch {
      report.undecryptableIds.push(row.id);
      continue;
    }
    const scopeKey = [newHash, ...column.scope.map((c) => row[c])].join('|');
    const owner = owners.get(scopeKey);
    if (owner) {
      report.conflictIds.push(owner, row.id);
    }
    owners.set(scopeKey, row.id);
    if (newHash !== row[column.hash]) {
      report.stale += 1;
      updates.push([row.id, newHash]);
    }
  }
  return { report, updates };
}

export async function rekeyIdentifierHashes(
  dataSource: DataSource,
  options: RekeyOptions,
): Promise<RekeyReport> {
  if (
    options.encryptionKey.toLowerCase() ===
    options.identifierHashKey.toLowerCase()
  ) {
    throw new Error('IDENTIFIER_HASH_KEY must differ from ENCRYPTION_KEY');
  }
  const encryptionKey = encryptionKeyFromHex(options.encryptionKey);
  const hashKey = encryptionKeyFromHex(options.identifierHashKey);

  return dataSource.transaction(async (manager) => {
    const report: RekeyReport = { applied: false, tables: {} };
    const pending: { column: IdentifierColumn; updates: [string, string][] }[] =
      [];
    for (const column of COLUMNS) {
      const result = await rekeyColumn(manager, column, encryptionKey, hashKey);
      report.tables[column.label] = result.report;
      pending.push({ column, updates: result.updates });
    }

    const tables = Object.values(report.tables);
    if (tables.some((t) => t.undecryptableIds.length > 0)) {
      throw new RekeyAbortedError(
        'Some ciphertext could not be decrypted with ENCRYPTION_KEY; nothing written',
        report,
      );
    }
    if (tables.some((t) => t.conflictIds.length > 0)) {
      throw new RekeyAbortedError(
        'Rows would collide on the new hash; nothing written',
        report,
      );
    }
    if (!options.allowOrphans && tables.some((t) => t.orphanIds.length > 0)) {
      throw new RekeyAbortedError(
        'Rows have a hash but no ciphertext; nothing written',
        report,
      );
    }

    if (options.apply) {
      for (const { column, updates } of pending) {
        for (const [id, hash] of updates) {
          await manager.query(
            `UPDATE ${column.table} SET ${column.hash} = $1 WHERE id = $2`,
            [hash, id],
          );
        }
      }
      report.applied = true;
    }
    return report;
  });
}

export function formatRekeyReport(report: RekeyReport): string {
  const lines = [report.applied ? 'APPLIED' : 'DRY RUN (nothing written)'];
  for (const [label, t] of Object.entries(report.tables)) {
    lines.push(
      `${label}: scanned=${t.scanned} stale=${t.stale} orphans=${t.orphanIds.length} undecryptable=${t.undecryptableIds.length} conflicts=${t.conflictIds.length}`,
    );
    if (t.orphanIds.length > 0) {
      lines.push(
        `  ORPHAN ROW IDS (hash left untouched): ${t.orphanIds.join(', ')}`,
      );
    }
    if (t.undecryptableIds.length > 0) {
      lines.push(`  UNDECRYPTABLE ROW IDS: ${t.undecryptableIds.join(', ')}`);
    }
    if (t.conflictIds.length > 0) {
      lines.push(
        `  CONFLICTING ROW IDS: ${[...new Set(t.conflictIds)].join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}

export function hasStaleHashes(report: RekeyReport): boolean {
  return Object.values(report.tables).some(
    (t) => t.stale > 0 || t.orphanIds.length > 0,
  );
}
