import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import {
  RekeyAbortedError,
  RekeyReport,
  formatRekeyReport,
  rekeyIdentifierHashes,
} from '../../src/database/rekey-identifier-hashes';
import {
  encryptSecret,
  encryptionKeyFromHex,
  hmacHex,
} from '../../src/shared/crypto/secrets.util';
import { CreateBankAccounts1787200000000 } from '../../src/database/migrations/1787200000000-CreateBankAccounts';
import { EncryptBankAccountNumbers1787400000000 } from '../../src/database/migrations/1787400000000-EncryptBankAccountNumbers';
import { CreateKycVerifications1787600000000 } from '../../src/database/migrations/1787600000000-CreateKycVerifications';

jest.setTimeout(180_000);

const ENCRYPTION_KEY = 'a'.repeat(64);
const NEW_KEY = 'c'.repeat(64);
const encKey = encryptionKeyFromHex(ENCRYPTION_KEY);
const newKey = encryptionKeyFromHex(NEW_KEY);

const BVN_A = '22222222201';
const NIN_A = '33333333301';
const BVN_B = '22222222202';
const ACCOUNT = '0123456789';

describe('rekey-identifier-hashes', () => {
  let postgres: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: postgres.getConnectionUri(),
    });
    await dataSource.initialize();
    const queryRunner = dataSource.createQueryRunner();
    await new CreateBankAccounts1787200000000().up(queryRunner);
    await new EncryptBankAccountNumbers1787400000000().up(queryRunner);
    await new CreateKycVerifications1787600000000().up(queryRunner);
    await queryRunner.release();
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE kyc_verifications, bank_accounts');
  });

  const options = (overrides: object = {}) => ({
    encryptionKey: ENCRYPTION_KEY,
    identifierHashKey: NEW_KEY,
    apply: true,
    allowOrphans: false,
    ...overrides,
  });

  async function seedKyc(
    fields: {
      bvn?: string;
      nin?: string;
      bvnHash?: string | null;
      bvnCiphertext?: string | null;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO kyc_verifications
         (id, user_id, bvn_ciphertext, bvn_hash, nin_ciphertext, nin_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        randomUUID(),
        fields.bvnCiphertext !== undefined
          ? fields.bvnCiphertext
          : fields.bvn
            ? encryptSecret(fields.bvn, encKey)
            : null,
        fields.bvnHash !== undefined
          ? fields.bvnHash
          : fields.bvn
            ? hmacHex(fields.bvn, encKey)
            : null,
        fields.nin ? encryptSecret(fields.nin, encKey) : null,
        fields.nin ? hmacHex(fields.nin, encKey) : null,
      ],
    );
    return id;
  }

  async function seedBankAccount(userId = randomUUID()): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO bank_accounts
         (id, user_id, provider, bank_code, bank_name, account_name,
          account_number_ciphertext, account_number_hash)
       VALUES ($1, $2, 'kora', '033', 'UBA', 'Ada Lovelace', $3, $4)`,
      [id, userId, encryptSecret(ACCOUNT, encKey), hmacHex(ACCOUNT, encKey)],
    );
    return id;
  }

  const hashesOf = (table: string, column: string) =>
    dataSource.query<Record<string, string | null>[]>(
      `SELECT id, ${column} AS hash FROM ${table} ORDER BY id`,
    );

  it('reports what would change on a dry run and writes nothing', async () => {
    await seedKyc({ bvn: BVN_A, nin: NIN_A });
    await seedBankAccount();
    const before = await hashesOf('kyc_verifications', 'bvn_hash');

    const report = await rekeyIdentifierHashes(
      dataSource,
      options({ apply: false }),
    );

    expect(report.applied).toBe(false);
    expect(report.tables['kyc_verifications.bvn'].stale).toBe(1);
    expect(report.tables['kyc_verifications.nin'].stale).toBe(1);
    expect(report.tables['bank_accounts.account_number'].stale).toBe(1);
    expect(await hashesOf('kyc_verifications', 'bvn_hash')).toEqual(before);
  });

  it('rederives every hash from the decrypted ciphertext under the new key, and a second run changes nothing', async () => {
    await seedKyc({ bvn: BVN_A, nin: NIN_A });
    await seedKyc({ bvn: BVN_B });
    await seedKyc();
    await seedBankAccount();

    await rekeyIdentifierHashes(dataSource, options());

    const bvnHashes = (await hashesOf('kyc_verifications', 'bvn_hash')).map(
      (r) => r.hash,
    );
    expect(bvnHashes).toEqual(
      expect.arrayContaining([hmacHex(BVN_A, newKey), hmacHex(BVN_B, newKey)]),
    );
    expect(bvnHashes).not.toContain(hmacHex(BVN_A, encKey));
    expect(hmacHex(BVN_A, newKey)).not.toBe(hmacHex(BVN_A, encKey));
    const ninRows = await dataSource.query<{ nin_hash: string | null }[]>(
      'SELECT nin_hash FROM kyc_verifications WHERE nin_hash IS NOT NULL',
    );
    expect(ninRows).toEqual([{ nin_hash: hmacHex(NIN_A, newKey) }]);
    const accountRows = await hashesOf('bank_accounts', 'account_number_hash');
    expect(accountRows[0].hash).toBe(hmacHex(ACCOUNT, newKey));

    const second = await rekeyIdentifierHashes(dataSource, options());
    expect(Object.values(second.tables).map((t) => t.stale)).toEqual([0, 0, 0]);
  });

  it('keeps one-account-per-identity enforced for the new hashes after the backfill', async () => {
    await seedKyc({ bvn: BVN_A });
    const accountUser = randomUUID();
    await seedBankAccount(accountUser);
    await rekeyIdentifierHashes(dataSource, options());

    await expect(
      dataSource.query(
        `INSERT INTO kyc_verifications (user_id, bvn_ciphertext, bvn_hash)
         VALUES ($1, 'x', $2)`,
        [randomUUID(), hmacHex(BVN_A, newKey)],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      dataSource.query(
        `INSERT INTO bank_accounts
           (user_id, provider, bank_code, bank_name, account_name,
            account_number_ciphertext, account_number_hash)
         VALUES ($1, 'kora', '033', 'UBA', 'Ada', 'x', $2)`,
        [accountUser, hmacHex(ACCOUNT, newKey)],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('aborts without writing when two rows would collide on the new hash', async () => {
    const first = await seedKyc({ bvn: BVN_A });
    const second = await seedKyc({ bvn: BVN_A, bvnHash: 'legacy-distinct' });
    await seedKyc({ bvn: BVN_B });
    const before = await hashesOf('kyc_verifications', 'bvn_hash');

    const error = await rekeyIdentifierHashes(dataSource, options()).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RekeyAbortedError);
    const report = (error as RekeyAbortedError).report;
    expect(report.tables['kyc_verifications.bvn'].conflictIds).toEqual(
      expect.arrayContaining([first, second]),
    );
    expect(await hashesOf('kyc_verifications', 'bvn_hash')).toEqual(before);
  });

  it('aborts by default on a row with a hash but no ciphertext, writing nothing', async () => {
    await seedKyc({ bvn: BVN_B });
    const orphan = await seedKyc({
      bvnCiphertext: null,
      bvnHash: 'orphan-hash',
    });
    const before = await hashesOf('kyc_verifications', 'bvn_hash');

    const error = await rekeyIdentifierHashes(dataSource, options()).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RekeyAbortedError);
    expect(
      (error as RekeyAbortedError).report.tables['kyc_verifications.bvn']
        .orphanIds,
    ).toEqual([orphan]);
    expect(await hashesOf('kyc_verifications', 'bvn_hash')).toEqual(before);
  });

  it('with allowOrphans, skips an orphan row and never changes or nulls its hash', async () => {
    await seedKyc({ bvn: BVN_B });
    const orphan = await seedKyc({
      bvnCiphertext: null,
      bvnHash: 'orphan-hash',
    });

    const report = await rekeyIdentifierHashes(
      dataSource,
      options({ allowOrphans: true }),
    );

    expect(report.tables['kyc_verifications.bvn'].orphanIds).toEqual([orphan]);
    const rows = await hashesOf('kyc_verifications', 'bvn_hash');
    expect(rows.find((r) => r.id === orphan)?.hash).toBe('orphan-hash');
    expect(rows.map((r) => r.hash)).toContain(hmacHex(BVN_B, newKey));
  });

  it('aborts when ciphertext cannot be decrypted with the encryption key', async () => {
    const wrongKey = encryptionKeyFromHex('d'.repeat(64));
    await seedKyc({
      bvnCiphertext: encryptSecret(BVN_A, wrongKey),
      bvnHash: 'whatever',
    });

    const error = await rekeyIdentifierHashes(dataSource, options()).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RekeyAbortedError);
    expect(
      (error as RekeyAbortedError).report.tables['kyc_verifications.bvn']
        .undecryptableIds,
    ).toHaveLength(1);
  });

  it('refuses identical encryption and hash keys', async () => {
    await expect(
      rekeyIdentifierHashes(
        dataSource,
        options({ identifierHashKey: ENCRYPTION_KEY.toUpperCase() }),
      ),
    ).rejects.toThrow('must differ');
  });

  it('prints neither keys, identifiers, ciphertext nor hashes', async () => {
    await seedKyc({ bvn: BVN_A, nin: NIN_A });
    await seedBankAccount();
    const ciphertext = (
      await dataSource.query<{ bvn_ciphertext: string }[]>(
        'SELECT bvn_ciphertext FROM kyc_verifications',
      )
    )[0].bvn_ciphertext;

    const report: RekeyReport = await rekeyIdentifierHashes(
      dataSource,
      options({ apply: false }),
    );
    const output = formatRekeyReport(report);

    for (const secret of [
      ENCRYPTION_KEY,
      NEW_KEY,
      BVN_A,
      NIN_A,
      ACCOUNT,
      ciphertext,
      hmacHex(BVN_A, encKey),
      hmacHex(BVN_A, newKey),
    ]) {
      expect(output).not.toContain(secret);
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
          join(repo, 'src/database/rekey-identifier-hashes.cli.ts'),
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

    const fullEnv = () => ({
      DATABASE_URL: postgres.getConnectionUri(),
      ENCRYPTION_KEY,
      IDENTIFIER_HASH_KEY: NEW_KEY,
    });

    it('exits non-zero on a dry run with stale hashes, applies on --apply, then exits zero', async () => {
      await seedKyc({ bvn: BVN_A });
      const before = await hashesOf('kyc_verifications', 'bvn_hash');

      const dry = runCli([], fullEnv());
      expect(dry.code).toBe(1);
      expect(await hashesOf('kyc_verifications', 'bvn_hash')).toEqual(before);

      const applied = runCli(['--apply'], fullEnv());
      expect(applied.code).toBe(0);

      const clean = runCli([], fullEnv());
      expect(clean.code).toBe(0);
      for (const secret of [
        ENCRYPTION_KEY,
        NEW_KEY,
        BVN_A,
        hmacHex(BVN_A, newKey),
      ]) {
        expect(dry.output + applied.output + clean.output).not.toContain(
          secret,
        );
      }
      expect((await hashesOf('kyc_verifications', 'bvn_hash'))[0].hash).toBe(
        hmacHex(BVN_A, newKey),
      );
    });

    it('needs only DATABASE_URL and the two keys, and fails without writing when the hash key is absent', async () => {
      await seedKyc({ bvn: BVN_A });
      const before = await hashesOf('kyc_verifications', 'bvn_hash');
      const env: Record<string, string> = fullEnv();
      delete env.IDENTIFIER_HASH_KEY;

      const result = runCli(['--apply'], env);

      expect(result.code).toBe(3);
      expect(result.output).toContain('IDENTIFIER_HASH_KEY');
      expect(result.output).not.toContain(ENCRYPTION_KEY);
      expect(await hashesOf('kyc_verifications', 'bvn_hash')).toEqual(before);
    });
  });
});
