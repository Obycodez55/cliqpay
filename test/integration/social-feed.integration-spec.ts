import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf, errorOf } from './support/api-response';
import { Follow } from '../../src/modules/social/entities/follow.entity';
import { KycTier } from '../../src/modules/users/users.service';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

interface Identity {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
}

interface FeedPost {
  transactionId: string;
  sender: Identity;
  recipient: Identity;
  note: string | null;
  createdAt: string;
}

interface FeedPage {
  items: FeedPost[];
  nextCursor: string | null;
}

describe('Social feed and post view', () => {
  let ctx: TransfersTestContext;
  let jwtService: JwtService;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0);
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  async function seedUser(prefix: string, kycTier: KycTier = 'tier1') {
    idSeq += 1;
    const n = idSeq;
    const { userId } = await seedTransferUser(ctx, {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348066${String(500_000 + n).padStart(6, '0')}`,
      username: `${prefix}_feed_${n}`,
      kycTier,
    });
    return userId;
  }

  async function follow(followerId: string, ...followeeIds: string[]) {
    await ctx.dataSource.getRepository(Follow).insert(
      followeeIds.map((followeeUserId) => ({
        followerUserId: followerId,
        followeeUserId,
      })),
    );
  }

  async function insertPost(options: {
    sender: string;
    recipient: string;
    visibility?: 'public' | 'private';
    hidden?: boolean;
    note?: string | null;
    createdAt?: string;
  }): Promise<string> {
    const transactionId = randomUUID();
    const visibility = options.visibility ?? 'public';
    await ctx.dataSource.query(
      `INSERT INTO transaction_posts
        (transaction_id, sender_user_id, recipient_user_id, note, visibility,
         requested_visibility, hidden_by_recipient, created_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, COALESCE($7::timestamptz, clock_timestamp()))`,
      [
        transactionId,
        options.sender,
        options.recipient,
        options.note === undefined ? 'lunch' : options.note,
        visibility,
        options.hidden ?? false,
        options.createdAt ?? null,
      ],
    );
    return transactionId;
  }

  function http() {
    return request(ctx.app.getHttpServer());
  }

  function getFeed(
    viewerId: string,
    query: Record<string, string | number> = {},
  ) {
    return http()
      .get('/social/feed')
      .query(query)
      .set('Authorization', `Bearer ${tokenFor(viewerId)}`);
  }

  function getPost(viewerId: string, transactionId: string) {
    return http()
      .get(`/social/posts/${transactionId}`)
      .set('Authorization', `Bearer ${tokenFor(viewerId)}`);
  }

  function block(blockerId: string, blockedId: string) {
    return http()
      .put(`/social/blocks/${blockedId}`)
      .set('Authorization', `Bearer ${tokenFor(blockerId)}`)
      .expect(200);
  }

  async function feedIds(viewerId: string): Promise<string[]> {
    const res = await getFeed(viewerId, { limit: 50 }).expect(200);
    return dataOf<FeedPage>(res).items.map((item) => item.transactionId);
  }

  describe('GET /social/feed', () => {
    it("shows a followed sender's public post with both participants and no amount", async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const viewer = await seedUser('viewer');
      await follow(viewer, sender);
      const transactionId = await insertPost({
        sender,
        recipient,
        note: 'suya money',
      });

      const res = await getFeed(viewer).expect(200);
      const page = dataOf<FeedPage>(res);

      expect(page.nextCursor).toBeNull();
      expect(page.items).toHaveLength(1);
      const [item] = page.items;
      expect(item).toEqual({
        transactionId,
        sender: {
          userId: sender,
          username: expect.stringMatching(/^sender_feed_/) as string,
          firstName: 'Ada',
          lastName: 'Lovelace',
        },
        recipient: {
          userId: recipient,
          username: expect.stringMatching(/^recipient_feed_/) as string,
          firstName: 'Ada',
          lastName: 'Lovelace',
        },
        note: 'suya money',
        createdAt: expect.any(String) as string,
        reactionCounts: {
          heart: 0,
          laugh: 0,
          wow: 0,
          fire: 0,
          clap: 0,
          pray: 0,
        },
        myReaction: null,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/amount/i);
    });

    it("shows a followed recipient's public post", async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const viewer = await seedUser('viewer');
      await follow(viewer, recipient);
      const transactionId = await insertPost({ sender, recipient });

      expect(await feedIds(viewer)).toEqual([transactionId]);
    });

    it("includes the viewer's own public posts on either side, not private or hidden ones", async () => {
      const viewer = await seedUser('viewer');
      const other = await seedUser('other');
      const sent = await insertPost({ sender: viewer, recipient: other });
      const received = await insertPost({ sender: other, recipient: viewer });
      await insertPost({
        sender: viewer,
        recipient: other,
        visibility: 'private',
      });
      await insertPost({ sender: viewer, recipient: other, hidden: true });

      expect(await feedIds(viewer)).toEqual([received, sent]);
    });

    it('excludes private and recipient-hidden posts by followed users', async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const viewer = await seedUser('viewer');
      await follow(viewer, sender, recipient);
      const visible = await insertPost({ sender, recipient });
      await insertPost({ sender, recipient, visibility: 'private' });
      await insertPost({ sender, recipient, hidden: true });

      expect(await feedIds(viewer)).toEqual([visible]);
    });

    it('excludes posts by users the viewer does not follow', async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const viewer = await seedUser('viewer');
      await insertPost({ sender, recipient });

      expect(await feedIds(viewer)).toEqual([]);
    });

    it('shows a post once when the viewer follows both participants', async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const viewer = await seedUser('viewer');
      await follow(viewer, sender, recipient);
      const transactionId = await insertPost({ sender, recipient });

      expect(await feedIds(viewer)).toEqual([transactionId]);
    });

    it('shows a post once when the viewer is a participant and follows the other', async () => {
      const viewer = await seedUser('viewer');
      const other = await seedUser('other');
      await follow(viewer, other);
      const transactionId = await insertPost({
        sender: viewer,
        recipient: other,
      });

      expect(await feedIds(viewer)).toEqual([transactionId]);
    });

    it.each([
      ['the viewer blocks the sender', 'viewer', 'sender'],
      ['the sender blocks the viewer', 'sender', 'viewer'],
      ['the viewer blocks the recipient', 'viewer', 'recipient'],
      ['the recipient blocks the viewer', 'recipient', 'viewer'],
    ] as const)(
      'excludes the post when %s, even through a follow of the other participant',
      async (_label, blockerRole, blockedRole) => {
        const users = {
          sender: await seedUser('sender'),
          recipient: await seedUser('recipient'),
          viewer: await seedUser('viewer'),
        };
        await follow(users.viewer, users.sender, users.recipient);
        const transactionId = await insertPost({
          sender: users.sender,
          recipient: users.recipient,
        });
        expect(await feedIds(users.viewer)).toEqual([transactionId]);

        await block(users[blockerRole], users[blockedRole]);

        expect(await feedIds(users.viewer)).toEqual([]);
        await getPost(users.viewer, transactionId).expect(404);
      },
    );

    it("excludes the viewer's own post when they and the counterparty are blocked", async () => {
      const viewer = await seedUser('viewer');
      const other = await seedUser('other');
      const transactionId = await insertPost({
        sender: viewer,
        recipient: other,
      });
      await block(other, viewer);

      expect(await feedIds(viewer)).toEqual([]);
      await getPost(viewer, transactionId).expect(200);
    });

    it('pages newest first with a stable cursor, including rows sharing a timestamp', async () => {
      const followedSender = await seedUser('sender');
      const followedRecipient = await seedUser('recipient');
      const stranger = await seedUser('stranger');
      const viewer = await seedUser('viewer');
      await follow(viewer, followedSender, followedRecipient);

      const timestamps = [
        '2026-01-01T10:00:00.123456Z',
        '2026-01-01T10:00:00.123456Z',
        '2026-01-01T10:00:00.123456Z',
        '2026-01-01T10:00:00.123789Z',
        '2026-01-01T10:00:00.123789Z',
        '2026-01-01T09:00:00Z',
        '2026-01-01T11:00:00Z',
      ];
      const inserted: string[] = [];
      for (const [i, createdAt] of timestamps.entries()) {
        inserted.push(
          await insertPost(
            i % 2 === 0
              ? { sender: followedSender, recipient: stranger, createdAt }
              : { sender: stranger, recipient: followedRecipient, createdAt },
          ),
        );
      }
      inserted.push(
        await insertPost({
          sender: followedSender,
          recipient: followedRecipient,
          createdAt: '2026-01-01T10:00:00.123456Z',
        }),
      );

      const expected = (
        await ctx.dataSource.query<{ transaction_id: string }[]>(
          `SELECT transaction_id FROM transaction_posts
           WHERE transaction_id = ANY($1)
           ORDER BY created_at DESC, id DESC`,
          [inserted],
        )
      ).map((row) => row.transaction_id);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: Record<string, string | number> = { limit: 3 };
        if (cursor) {
          query.cursor = cursor;
        }
        const page = dataOf<FeedPage>(await getFeed(viewer, query).expect(200));
        expect(page.items.length).toBeLessThanOrEqual(3);
        seen.push(...page.items.map((item) => item.transactionId));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual(expected);
      expect(seen).toHaveLength(8);
    });

    it('defaults to 20 items and rejects a limit above 50', async () => {
      const viewer = await seedUser('viewer');
      const other = await seedUser('other');
      for (let i = 0; i < 21; i += 1) {
        await insertPost({ sender: viewer, recipient: other });
      }

      const page = dataOf<FeedPage>(await getFeed(viewer).expect(200));
      expect(page.items).toHaveLength(20);
      expect(page.nextCursor).not.toBeNull();

      await getFeed(viewer, { limit: 51 }).expect(400);
    });

    it('rejects a malformed cursor', async () => {
      const viewer = await seedUser('viewer');
      await getFeed(viewer, { cursor: 'not-a-cursor' }).expect(400);
    });

    it('rejects Tier 0 users', async () => {
      const viewer = await seedUser('viewer', 'tier0');

      const res = await getFeed(viewer).expect(422);
      expect(errorOf(res).code).toBe('KYC_VERIFICATION_REQUIRED');
    });
  });

  describe('GET /social/posts/:transactionId', () => {
    it('lets both participants read their own private and hidden posts', async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const privatePost = await insertPost({
        sender,
        recipient,
        visibility: 'private',
        note: 'rent',
      });
      const hiddenPost = await insertPost({ sender, recipient, hidden: true });

      for (const viewer of [sender, recipient]) {
        const res = await getPost(viewer, privatePost).expect(200);
        expect(dataOf<FeedPost>(res)).toMatchObject({
          transactionId: privatePost,
          sender: { userId: sender },
          recipient: { userId: recipient },
          note: 'rent',
        });
        expect(JSON.stringify(res.body)).not.toMatch(/amount/i);
        await getPost(viewer, hiddenPost).expect(200);
      }
      expect(await feedIds(sender)).toEqual([]);
    });

    it('lets a follower of either participant read a public post', async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const senderFollower = await seedUser('viewer');
      const recipientFollower = await seedUser('viewer');
      await follow(senderFollower, sender);
      await follow(recipientFollower, recipient);
      const transactionId = await insertPost({ sender, recipient });

      for (const viewer of [senderFollower, recipientFollower]) {
        const res = await getPost(viewer, transactionId).expect(200);
        expect(dataOf<FeedPost>(res).transactionId).toBe(transactionId);
      }
    });

    it('returns 404 to non-participants for private, hidden, unfollowed or missing posts', async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const follower = await seedUser('viewer');
      const stranger = await seedUser('stranger');
      await follow(follower, sender, recipient);
      const privatePost = await insertPost({
        sender,
        recipient,
        visibility: 'private',
      });
      const hiddenPost = await insertPost({ sender, recipient, hidden: true });
      const publicPost = await insertPost({ sender, recipient });

      for (const transactionId of [privatePost, hiddenPost]) {
        const res = await getPost(follower, transactionId).expect(404);
        expect(errorOf(res).code).toBe('POST_NOT_FOUND');
      }
      expect(
        errorOf(await getPost(stranger, publicPost).expect(404)).code,
      ).toBe('POST_NOT_FOUND');
      expect(
        errorOf(await getPost(follower, randomUUID()).expect(404)).code,
      ).toBe('POST_NOT_FOUND');
    });

    it('rejects Tier 0 users, even participants', async () => {
      const sender = await seedUser('sender', 'tier0');
      const recipient = await seedUser('recipient');
      const transactionId = await insertPost({ sender, recipient });

      const res = await getPost(sender, transactionId).expect(422);
      expect(errorOf(res).code).toBe('KYC_VERIFICATION_REQUIRED');
    });
  });
});
