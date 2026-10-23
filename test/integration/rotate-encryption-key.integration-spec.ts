import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source.options';
import {
  RotateAbortedError,
  formatRotateReport,
  rotateEncryptionKey,
} from '../../src/database/rotate-encryption-key';
import {
  decryptSecret,
  encryptSecret,
  encryptionKeyFromHex,
  hmacHex,
} from '../../src/shared/crypto/secrets.util';

jest.setTimeout(180_000);

const OLD_KEY = 'a'.repeat(64);
const NEW_KEY = 'c'.repeat(64);
const OTHER_KEY = 'd'.repeat(64);
const HASH_KEY = 'e'.repeat(64);
const oldKey = encryptionKeyFromHex(OLD_KEY);
const newKey = encryptionKeyFromHex(NEW_KEY);
const otherKey = encryptionKeyFromHex(OTHER_KEY);
const hashKey = encryptionKeyFromHex(HASH_KEY);

const TOTP = 'JBSWY3DPEHPK3PXP';
const BVN = '22222222201';
const NIN = '33333333301';
const ACCOUNT = '0123456789';

const COLUMNS = [
  ['mfa_methods', 'secret_ciphertext'],
  ['bank_accounts', 'account_number_ciphertext'],
  ['kyc_verifications', 'bvn_ciphertext'],
  ['kyc_verifications', 'nin_ciphertext'],
] as const;

describe('rotate-encryption-key', () => {
  let postgres: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    dataSource = new DataSource(
      buildDataSourceOptions({
        database: { url: postgres.getConnectionUri() },
      }),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE mfa_methods, kyc_verifications, bank_accounts CASCADE',
    );
  });

  const options = (overrides: object = {}) => ({
    oldKey: OLD_KEY,
    newKey: NEW_KEY,
    apply: true,
    ...overrides,
  });

  async function seedAll(key: Buffer = oldKey) {
    const mfa = randomUUID();
    await dataSource.query(
      `INSERT INTO mfa_methods (id, user_id, type, status, secret_ciphertext)
       VALUES ($1, $2, 'totp', 'active', $3)`,
      [mfa, randomUUID(), encryptSecret(TOTP, key)],
    );
    const bank = randomUUID();
    await dataSource.query(
      `INSERT INTO bank_accounts
         (id, user_id, provider, bank_code, bank_name, account_name,
          account_number_ciphertext, account_number_hash)
       VALUES ($1, $2, 'kora', '033', 'UBA', 'Ada Lovelace', $3, $4)`,
      [
        bank,
        randomUUID(),
        encryptSecret(ACCOUNT, key),
        hmacHex(ACCOUNT, hashKey),
      ],
    );
    const kyc = randomUUID();
    await dataSource.query(
      `INSERT INTO kyc_verifications
         (id, user_id, bvn_ciphertext, bvn_hash, nin_ciphertext, nin_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        kyc,
        randomUUID(),
        encryptSecret(BVN, key),
        hmacHex(BVN, hashKey),
        encryptSecret(NIN, key),
        hmacHex(NIN, hashKey),
      ],
    );
    return { mfa, bank, kyc };
  }

  async function snapshot() {
    const out: Record<string, unknown> = {};
    for (const [table, column] of COLUMNS) {
      out[`${table}.${column}`] = await dataSource.query(
        `SELECT id, ${column} AS value FROM ${table} ORDER BY id`,
      );
    }
    out.hashes = await dataSource.query(
      `SELECT bvn_hash, nin_hash FROM kyc_verifications`,
    );
    out.accountHashes = await dataSource.query(
      `SELECT account_number_hash FROM bank_accounts`,
    );
    return out;
  }

  async function allCiphertext(): Promise<string[]> {
    const values: string[] = [];
    for (const [table, column] of COLUMNS) {
      const rows = await dataSource.query<{ value: string | null }[]>(
        `SELECT ${column} AS value FROM ${table}`,
      );
      values.push(...rows.flatMap((r) => (r.value ? [r.value] : [])));
    }
    return values;
  }

  const decrypts = (ciphertext: string, key: Buffer) => {
    try {
      decryptSecret(ciphertext, key);
      return true;
    } catch {
      return false;
    }
  };

  it('re-encrypts every ciphertext column so it decrypts with the new key and not the old', async () => {
    await seedAll();

    const report = await rotateEncryptionKey(dataSource, options());

    expect(report.applied).toBe(true);
    expect(Object.values(report.columns).map((c) => c.rotate)).toEqual([
      1, 1, 1, 1,
    ]);
    const values = await allCiphertext();
    expect(values).toHaveLength(4);
    for (const value of values) {
      expect(decrypts(value, newKey)).toBe(true);
      expect(decrypts(value, oldKey)).toBe(false);
    }
    const [mfa] = await dataSource.query<{ v: string }[]>(
      'SELECT secret_ciphertext AS v FROM mfa_methods',
    );
    expect(decryptSecret(mfa.v, newKey)).toBe(TOTP);
    const [kyc] = await dataSource.query<{ b: string; n: string }[]>(
      'SELECT bvn_ciphertext AS b, nin_ciphertext AS n FROM kyc_verifications',
    );
    expect(decryptSecret(kyc.b, newKey)).toBe(BVN);
    expect(decryptSecret(kyc.n, newKey)).toBe(NIN);
    const [bank] = await dataSource.query<{ v: string }[]>(
      'SELECT account_number_ciphertext AS v FROM bank_accounts',
    );
    expect(decryptSecret(bank.v, newKey)).toBe(ACCOUNT);
  });

  it('reports what would change on a dry run and writes nothing', async () => {
    await seedAll();
    const before = await snapshot();

    const report = await rotateEncryptionKey(
      dataSource,
      options({ apply: false }),
    );

    expect(report.applied).toBe(false);
    expect(Object.values(report.columns).map((c) => c.rotate)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it('is a no-op on a second run', async () => {
    await seedAll();
    await rotateEncryptionKey(dataSource, options());
    const after = await snapshot();

    const second = await rotateEncryptionKey(dataSource, options());

    expect(
      Object.values(second.columns).map((c) => [c.rotate, c.alreadyRotated]),
    ).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
    expect(await snapshot()).toEqual(after);
  });

  it('rotates only the rows still on the old key when some are already on the new one', async () => {
    const { mfa } = await seedAll();
    const rotated = encryptSecret(TOTP, newKey);
    await dataSource.query(
      'UPDATE mfa_methods SET secret_ciphertext = $1 WHERE id = $2',
      [rotated, mfa],
    );

    const report = await rotateEncryptionKey(dataSource, options());

    expect(report.columns['mfa_methods.secret_ciphertext']).toMatchObject({
      rotate: 0,
      alreadyRotated: 1,
    });
    const [row] = await dataSource.query<{ v: string }[]>(
      'SELECT secret_ciphertext AS v FROM mfa_methods',
    );
    expect(row.v).toBe(rotated);
    for (const value of await allCiphertext()) {
      expect(decrypts(value, newKey)).toBe(true);
    }
  });

  it('skips null ciphertext', async () => {
    await dataSource.query(
      `INSERT INTO mfa_methods (user_id, type, status) VALUES ($1, 'email', 'active')`,
      [randomUUID()],
    );

    const report = await rotateEncryptionKey(dataSource, options());

    expect(report.columns['mfa_methods.secret_ciphertext'].scanned).toBe(0);
  });

  it('aborts with every row unchanged when any value decrypts with neither key', async () => {
    await seedAll();
    const bad = randomUUID();
    await dataSource.query(
      `INSERT INTO kyc_verifications (id, user_id, bvn_ciphertext, bvn_hash)
       VALUES ($1, $2, $3, 'h')`,
      [bad, randomUUID(), encryptSecret(BVN, otherKey)],
    );
    const before = await snapshot();

    const error = await rotateEncryptionKey(dataSource, options()).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RotateAbortedError);
    expect(
      (error as RotateAbortedError).report.columns[
        'kyc_verifications.bvn_ciphertext'
      ].undecryptableIds,
    ).toEqual([bad]);
    expect(await snapshot()).toEqual(before);
  });

  it('aborts on a malformed ciphertext', async () => {
    await seedAll();
    await dataSource.query(
      `UPDATE bank_accounts SET account_number_ciphertext = 'not-a-ciphertext'`,
    );
    const before = await snapshot();

    await expect(rotateEncryptionKey(dataSource, options())).rejects.toThrow(
      RotateAbortedError,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('rejects identical old and new keys', async () => {
    await expect(
      rotateEncryptionKey(
        dataSource,
        options({ newKey: OLD_KEY.toUpperCase() }),
      ),
    ).rejects.toThrow('must differ');
  });

  it('leaves the lookup hashes untouched', async () => {
    await seedAll();
    const hashesBefore = {
      kyc: await dataSource.query<unknown[]>(
        'SELECT bvn_hash, nin_hash FROM kyc_verifications',
      ),
      bank: await dataSource.query<unknown[]>(
        'SELECT account_number_hash FROM bank_accounts',
      ),
    };

    await rotateEncryptionKey(dataSource, options());

    expect(
      await dataSource.query(
        'SELECT bvn_hash, nin_hash FROM kyc_verifications',
      ),
    ).toEqual(hashesBefore.kyc);
    expect(
      await dataSource.query('SELECT account_number_hash FROM bank_accounts'),
    ).toEqual(hashesBefore.bank);
  });

  it('prints no keys, plaintext or ciphertext', async () => {
    await seedAll();
    const ciphertexts = await allCiphertext();

    const dry = formatRotateReport(
      await rotateEncryptionKey(dataSource, options({ apply: false })),
    );
    const applied = formatRotateReport(
      await rotateEncryptionKey(dataSource, options()),
    );

    for (const secret of [
      OLD_KEY,
      NEW_KEY,
      TOTP,
      BVN,
      NIN,
      ACCOUNT,
      ...ciphertexts,
    ]) {
      expect(dry + applied).not.toContain(secret);
    }
  });

  describe('CLI', () => {
    const repo = join(__dirname, '..', '..');

    function runCli(args: string[], env: Record<string, string>) {
      const result = spawnSync(
        process.execPath,
        [
          '-r',
          require.resolve('ts-node/register'),
          join(repo, 'src/database/rotate-encryption-key.cli.ts'),
          ...args,
        ],
        {
          cwd: '/',
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            TS_NODE_PROJECT: join(repo, 'tsconfig.json'),
            TS_NODE_TRANSPILE_ONLY: 'true',
            ...env,
          },
        },
      );
      return {
        code: result.status,
        output: `${result.stdout}${result.stderr}`,
      };
    }

    const fullEnv = (): Record<string, string> => ({
      DATABASE_URL: postgres.getConnectionUri(),
      OLD_ENCRYPTION_KEY: OLD_KEY,
      NEW_ENCRYPTION_KEY: NEW_KEY,
    });

    it('exits 1 on a dry run with work to do, applies on --apply, then exits 0', async () => {
      await seedAll();
      const before = await snapshot();

      const dry = runCli([], fullEnv());
      expect(dry.code).toBe(1);
      expect(await snapshot()).toEqual(before);

      const applied = runCli(['--apply'], fullEnv());
      expect(applied.code).toBe(0);
      for (const value of await allCiphertext()) {
        expect(decrypts(value, newKey)).toBe(true);
        expect(decrypts(value, oldKey)).toBe(false);
      }

      const clean = runCli([], fullEnv());
      expect(clean.code).toBe(0);
      for (const secret of [OLD_KEY, NEW_KEY, TOTP, BVN, NIN, ACCOUNT]) {
        expect(dry.output + applied.output + clean.output).not.toContain(
          secret,
        );
      }
    });

    it('exits 2 and writes nothing when a value cannot be decrypted', async () => {
      await seedAll(otherKey);
      const before = await snapshot();

      const result = runCli(['--apply'], fullEnv());

      expect(result.code).toBe(2);
      expect(result.output).toContain('UNDECRYPTABLE ROW IDS');
      expect(await snapshot()).toEqual(before);
    });

    it('exits 3 without writing when a key is absent, and needs nothing else', async () => {
      await seedAll();
      const before = await snapshot();
      const env = fullEnv();
      delete env.NEW_ENCRYPTION_KEY;

      const result = runCli(['--apply'], env);

      expect(result.code).toBe(3);
      expect(result.output).toContain('NEW_ENCRYPTION_KEY');
      expect(result.output).not.toContain(OLD_KEY);
      expect(await snapshot()).toEqual(before);
    });

    it('exits 3 when old and new keys are equal', async () => {
      await seedAll();
      const before = await snapshot();

      const result = runCli(['--apply'], {
        ...fullEnv(),
        NEW_ENCRYPTION_KEY: OLD_KEY,
      });

      expect(result.code).toBe(3);
      expect(result.output).not.toContain(OLD_KEY);
      expect(await snapshot()).toEqual(before);
    });
  });
});
