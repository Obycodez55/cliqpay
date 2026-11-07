import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source.options';
import {
  TestDatabase,
  createTestDatabase,
  dropTestDatabase,
} from './support/test-database';

jest.setTimeout(120_000);

interface Seed {
  transactionId: string;
  sender: string;
  recipient: string;
  visibility: 'public' | 'private';
  hidden: boolean;
  reactors: string[];
  comments: { body: string; deleted: boolean }[];
}

interface Snapshot {
  posts: string[];
  reactions: string[];
  comments: string[];
}

describe('GeneralisePostsToParticipants migration', () => {
  let db: TestDatabase;
  let dataSource: DataSource;

  beforeAll(async () => {
    db = await createTestDatabase();
    dataSource = new DataSource({
      ...buildDataSourceOptions({ database: { url: db.url } }),
      migrationsRun: false,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await dropTestDatabase(db);
  });

  async function seedLegacyPosts(): Promise<Seed[]> {
    const seeds: Seed[] = [
      ['public', false, 3, 2],
      ['public', true, 2, 1],
      ['private', false, 1, 1],
      ['private', true, 0, 0],
      ['public', false, 0, 3],
    ].map(([visibility, hidden, reactors, comments]) => ({
      transactionId: randomUUID(),
      sender: randomUUID(),
      recipient: randomUUID(),
      visibility: visibility as 'public' | 'private',
      hidden: hidden as boolean,
      reactors: Array.from({ length: reactors as number }, () => randomUUID()),
      comments: Array.from({ length: comments as number }, (_, i) => ({
        body: `comment ${i}`,
        deleted: i === 1,
      })),
    }));

    for (const [index, seed] of seeds.entries()) {
      const [post]: { id: string }[] = await dataSource.query(
        `INSERT INTO transaction_posts
          (transaction_id, sender_user_id, recipient_user_id, note, visibility,
           requested_visibility, hidden_by_recipient, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'private', $6,
           '2026-03-01T10:00:00.123456Z'::timestamptz + make_interval(mins => $7),
           '2026-03-02T10:00:00.654321Z')
         RETURNING id`,
        [
          seed.transactionId,
          seed.sender,
          seed.recipient,
          `note ${index}`,
          seed.visibility,
          seed.hidden,
          index,
        ],
      );
      for (const [i, reactor] of seed.reactors.entries()) {
        await dataSource.query(
          `INSERT INTO post_reactions (post_id, user_id, reaction) VALUES ($1, $2, $3)`,
          [post.id, reactor, ['heart', 'fire', 'clap'][i % 3]],
        );
      }
      for (const comment of seed.comments) {
        await dataSource.query(
          `INSERT INTO post_comments (post_id, author_user_id, body, deleted_at, deleted_by_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            post.id,
            seed.sender,
            comment.body,
            comment.deleted ? new Date() : null,
            comment.deleted ? seed.sender : null,
          ],
        );
      }
    }
    return seeds;
  }

  async function snapshotLegacy(): Promise<Snapshot> {
    return {
      posts: (
        await dataSource.query<Record<string, unknown>[]>(
          `SELECT transaction_id, sender_user_id, recipient_user_id, note, visibility,
            requested_visibility, hidden_by_recipient, created_at::text, updated_at::text
           FROM transaction_posts ORDER BY transaction_id`,
        )
      ).map((row) => JSON.stringify(row)),
      reactions: (
        await dataSource.query<Record<string, unknown>[]>(
          `SELECT tp.transaction_id, r.user_id, r.reaction
           FROM post_reactions r JOIN transaction_posts tp ON tp.id = r.post_id
           ORDER BY tp.transaction_id, r.user_id`,
        )
      ).map((row) => JSON.stringify(row)),
      comments: (
        await dataSource.query<Record<string, unknown>[]>(
          `SELECT tp.transaction_id, c.id, c.body, c.deleted_at IS NOT NULL AS deleted
           FROM post_comments c JOIN transaction_posts tp ON tp.id = c.post_id
           ORDER BY tp.transaction_id, c.id`,
        )
      ).map((row) => JSON.stringify(row)),
    };
  }

  async function snapshotGeneralised(): Promise<Snapshot> {
    return {
      posts: (
        await dataSource.query<Record<string, unknown>[]>(
          `SELECT p.id AS transaction_id, a.user_id AS sender_user_id, c.user_id AS recipient_user_id,
            p.note, p.visibility, p.requested_visibility, c.hidden AS hidden_by_recipient,
            p.created_at::text, p.updated_at::text
           FROM posts p
           JOIN post_participants a ON a.post_id = p.id AND a.role = 'author'
           JOIN post_participants c ON c.post_id = p.id AND c.role = 'counterparty'
           ORDER BY p.id`,
        )
      ).map((row) => JSON.stringify(row)),
      reactions: (
        await dataSource.query<Record<string, unknown>[]>(
          `SELECT post_id AS transaction_id, user_id, reaction
           FROM post_reactions ORDER BY post_id, user_id`,
        )
      ).map((row) => JSON.stringify(row)),
      comments: (
        await dataSource.query<Record<string, unknown>[]>(
          `SELECT post_id AS transaction_id, id, body, deleted_at IS NOT NULL AS deleted
           FROM post_comments ORDER BY post_id, id`,
        )
      ).map((row) => JSON.stringify(row)),
    };
  }

  async function expectGeneralisedFlags(seeds: Seed[]): Promise<void> {
    const rows: {
      id: string;
      is_public: boolean;
      participants: number;
      public_copies: number;
      created_copies: number;
    }[] = await dataSource.query(
      `SELECT p.id, p.is_public, COUNT(pp.user_id)::int AS participants,
        COUNT(*) FILTER (WHERE pp.post_is_public = p.is_public)::int AS public_copies,
        COUNT(*) FILTER (WHERE pp.post_created_at = p.created_at)::int AS created_copies
       FROM posts p JOIN post_participants pp ON pp.post_id = p.id
       GROUP BY p.id`,
    );
    expect(rows).toHaveLength(seeds.length);
    for (const seed of seeds) {
      const row = rows.find((r) => r.id === seed.transactionId)!;
      expect(row.is_public).toBe(seed.visibility === 'public' && !seed.hidden);
      expect(row.participants).toBe(2);
      expect(row.public_copies).toBe(2);
      expect(row.created_copies).toBe(2);
    }
    const hidden: { post_id: string; hidden: boolean }[] =
      await dataSource.query(
        `SELECT post_id, hidden FROM post_participants WHERE role = 'counterparty'`,
      );
    for (const seed of seeds) {
      expect(hidden.find((h) => h.post_id === seed.transactionId)?.hidden).toBe(
        seed.hidden,
      );
    }
    const [{ count }]: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM post_participants WHERE role = 'author' AND hidden`,
    );
    expect(count).toBe(0);
  }

  it('moves posts, reactions and comments through up, down and up without losing or re-homing any', async () => {
    await dataSource.undoLastMigration();
    const seeds = await seedLegacyPosts();
    const legacy = await snapshotLegacy();
    expect(legacy.posts).toHaveLength(5);
    expect(legacy.reactions).toHaveLength(6);
    expect(legacy.comments).toHaveLength(7);

    await dataSource.runMigrations();
    const upOnce = await snapshotGeneralised();
    expect(upOnce).toEqual(legacy);
    await expectGeneralisedFlags(seeds);
    expect(
      await dataSource.query(`SELECT to_regclass('transaction_posts') AS t`),
    ).toEqual([{ t: null }]);

    await dataSource.undoLastMigration();
    expect(await snapshotLegacy()).toEqual(legacy);
    expect(await dataSource.query(`SELECT to_regclass('posts') AS t`)).toEqual([
      { t: null },
    ]);

    await dataSource.runMigrations();
    expect(await snapshotGeneralised()).toEqual(legacy);
    await expectGeneralisedFlags(seeds);
  });
});
