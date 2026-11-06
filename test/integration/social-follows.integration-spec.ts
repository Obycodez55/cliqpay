import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf, errorOf } from './support/api-response';
import { Follow } from '../../src/modules/social/entities/follow.entity';
import { KycTier } from '../../src/modules/users/users.service';
import { DOMAIN_EVENTS_QUEUE } from '../../src/shared/events/event-bus.service';
import { CHANNEL_DISPATCH_QUEUE } from '../../src/modules/notifications/internal/channel-dispatch.queue';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface IdentityItem {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
}

interface Page {
  items: IdentityItem[];
  nextCursor: string | null;
}

interface Relationship {
  userId: string;
  follows: boolean;
  followedBy: boolean;
  followerCount: number;
  followingCount: number;
}

describe('Social follows', () => {
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

  const followRepo = () => ctx.dataSource.getRepository(Follow);

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  async function seedUser(prefix: string, kycTier: KycTier = 'tier1') {
    idSeq += 1;
    const n = idSeq;
    return seedTransferUser(ctx, {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348055${String(400_000 + n).padStart(6, '0')}`,
      username: `${prefix}_follow_${n}`,
      kycTier,
    });
  }

  function http() {
    return request(ctx.app.getHttpServer());
  }

  function follow(followerId: string, followeeId: string) {
    return http()
      .put(`/social/follows/${followeeId}`)
      .set('Authorization', `Bearer ${tokenFor(followerId)}`);
  }

  function unfollow(followerId: string, followeeId: string) {
    return http()
      .delete(`/social/follows/${followeeId}`)
      .set('Authorization', `Bearer ${tokenFor(followerId)}`);
  }

  function list(
    userId: string,
    side: 'followers' | 'following',
    query: Record<string, string | number> = {},
  ) {
    return http()
      .get(`/social/${side}`)
      .query(query)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);
  }

  function relationship(viewerId: string, otherId: string) {
    return http()
      .get(`/social/users/${otherId}/relationship`)
      .set('Authorization', `Bearer ${tokenFor(viewerId)}`);
  }

  async function waitForQueuesDrained(): Promise<void> {
    const queues = [DOMAIN_EVENTS_QUEUE, CHANNEL_DISPATCH_QUEUE].map((name) =>
      ctx.app.get<Queue>(getQueueToken(name)),
    );
    await waitFor(async () => {
      for (const queue of queues) {
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'prioritized',
        );
        if (Object.values(counts).some((count) => count > 0)) {
          return false;
        }
      }
      return true;
    });
  }

  describe('PUT /social/follows/:userId', () => {
    it('follows a user and is idempotent', async () => {
      const follower = await seedUser('fa');
      const followee = await seedUser('fb');

      const first = await follow(follower.userId, followee.userId).expect(200);
      expect(dataOf(first)).toEqual({ userId: followee.userId, follows: true });
      await follow(follower.userId, followee.userId).expect(200);

      expect(
        await followRepo().countBy({
          followerUserId: follower.userId,
          followeeUserId: followee.userId,
        }),
      ).toBe(1);
    });

    it('rejects following yourself with a 400', async () => {
      const user = await seedUser('self');

      const res = await follow(user.userId, user.userId).expect(400);

      expect(errorOf(res).code).toBe('SELF_FOLLOW_NOT_ALLOWED');
      expect(await followRepo().countBy({ followerUserId: user.userId })).toBe(
        0,
      );
    });

    it('rejects following a user that does not exist with a 404', async () => {
      const user = await seedUser('ghost');

      const res = await follow(user.userId, randomUUID()).expect(404);

      expect(errorOf(res).code).toBe('USER_NOT_FOUND');
    });

    it('enforces the database CHECK against self-follows', async () => {
      const user = await seedUser('check');

      await expect(
        followRepo().insert({
          followerUserId: user.userId,
          followeeUserId: user.userId,
        }),
      ).rejects.toThrow(/CHK_follows_not_self/);
    });
  });

  describe('DELETE /social/follows/:userId', () => {
    it('unfollows and is idempotent', async () => {
      const follower = await seedUser('ua');
      const followee = await seedUser('ub');
      await follow(follower.userId, followee.userId).expect(200);

      const first = await unfollow(follower.userId, followee.userId).expect(
        200,
      );
      expect(dataOf(first)).toEqual({
        userId: followee.userId,
        follows: false,
      });
      await unfollow(follower.userId, followee.userId).expect(200);

      expect(
        await followRepo().countBy({ followerUserId: follower.userId }),
      ).toBe(0);
    });
  });

  describe('following cap', () => {
    async function fillToCap(followerId: string): Promise<void> {
      await ctx.dataSource.query(
        `INSERT INTO follows (follower_user_id, followee_user_id)
         SELECT $1, gen_random_uuid() FROM generate_series(1, 5000)`,
        [followerId],
      );
    }

    it('rejects following a 5,001st user with a clear error', async () => {
      const follower = await seedUser('cap');
      const followee = await seedUser('capb');
      await fillToCap(follower.userId);

      const res = await follow(follower.userId, followee.userId).expect(422);

      expect(errorOf(res)).toMatchObject({
        code: 'FOLLOW_LIMIT_REACHED',
        details: { limit: 5000 },
      });
      expect(errorOf(res).message).toContain('5,000');
      expect(
        await followRepo().countBy({ followerUserId: follower.userId }),
      ).toBe(5000);
    });

    it('still treats re-following an already-followed user at the cap as a no-op success', async () => {
      const follower = await seedUser('capre');
      const followee = await seedUser('capreb');
      await follow(follower.userId, followee.userId).expect(200);
      await ctx.dataSource.query(
        `INSERT INTO follows (follower_user_id, followee_user_id)
         SELECT $1, gen_random_uuid() FROM generate_series(1, 4999)`,
        [follower.userId],
      );

      await follow(follower.userId, followee.userId).expect(200);
    });

    it('holds the cap under concurrent follows', async () => {
      const follower = await seedUser('capconc');
      const followees = await Promise.all([
        seedUser('capconcb'),
        seedUser('capconcc'),
        seedUser('capconcd'),
      ]);
      await ctx.dataSource.query(
        `INSERT INTO follows (follower_user_id, followee_user_id)
         SELECT $1, gen_random_uuid() FROM generate_series(1, 4999)`,
        [follower.userId],
      );

      const results = await Promise.all(
        followees.map((followee) => follow(follower.userId, followee.userId)),
      );

      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      expect(results.filter((res) => res.status === 422)).toHaveLength(2);
      expect(
        await followRepo().countBy({ followerUserId: follower.userId }),
      ).toBe(5000);
    });
  });

  describe('KYC gate', () => {
    it('rejects a Tier 0 caller on every endpoint', async () => {
      const tier0 = await seedUser('tierzero', 'tier0');
      const other = await seedUser('tierother');
      const calls = [
        follow(tier0.userId, other.userId),
        unfollow(tier0.userId, other.userId),
        list(tier0.userId, 'followers'),
        list(tier0.userId, 'following'),
        relationship(tier0.userId, other.userId),
      ];

      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('KYC_VERIFICATION_REQUIRED');
      }
      expect(await followRepo().countBy({ followerUserId: tier0.userId })).toBe(
        0,
      );
    });
  });

  describe('GET /social/followers and /social/following', () => {
    async function setCreatedAt(
      followerUserId: string,
      followeeUserId: string,
      createdAt: string,
    ): Promise<void> {
      await followRepo().update(
        { followerUserId, followeeUserId },
        { createdAt: new Date(createdAt) },
      );
    }

    it("returns the caller's own followers newest first, keyset paginated", async () => {
      const owner = await seedUser('owner');
      const followers = await Promise.all([
        seedUser('fl1'),
        seedUser('fl2'),
        seedUser('fl3'),
      ]);
      for (const follower of followers) {
        await follow(follower.userId, owner.userId).expect(200);
      }
      await setCreatedAt(
        followers[0].userId,
        owner.userId,
        '2026-01-01T00:00:00Z',
      );
      await setCreatedAt(
        followers[1].userId,
        owner.userId,
        '2026-01-03T00:00:00Z',
      );
      await setCreatedAt(
        followers[2].userId,
        owner.userId,
        '2026-01-02T00:00:00Z',
      );

      const first = dataOf<Page>(
        await list(owner.userId, 'followers', { limit: 2 }).expect(200),
      );
      expect(first.items.map((item) => item.userId)).toEqual([
        followers[1].userId,
        followers[2].userId,
      ]);
      expect(first.nextCursor).not.toBeNull();

      const second = dataOf<Page>(
        await list(owner.userId, 'followers', {
          limit: 2,
          cursor: first.nextCursor!,
        }).expect(200),
      );
      expect(second.items.map((item) => item.userId)).toEqual([
        followers[0].userId,
      ]);
      expect(second.nextCursor).toBeNull();
    });

    it('breaks ties on identical timestamps without skipping or repeating rows', async () => {
      const owner = await seedUser('tie');
      const followees = await Promise.all([
        seedUser('tie1'),
        seedUser('tie2'),
        seedUser('tie3'),
      ]);
      for (const followee of followees) {
        await follow(owner.userId, followee.userId).expect(200);
        await setCreatedAt(
          owner.userId,
          followee.userId,
          '2026-02-01T00:00:00Z',
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Page = dataOf<Page>(
          await list(owner.userId, 'following', {
            limit: 1,
            ...(cursor ? { cursor } : {}),
          }).expect(200),
        );
        seen.push(...page.items.map((item) => item.userId));
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toEqual(
        followees
          .map((followee) => followee.userId)
          .sort()
          .reverse(),
      );
    });

    it('returns only id, username and display name for each entry', async () => {
      const owner = await seedUser('shape');
      const followee = await seedUser('shapeb');
      await follow(owner.userId, followee.userId).expect(200);

      const page = dataOf<Page>(
        await list(owner.userId, 'following').expect(200),
      );

      expect(page.items).toEqual([
        {
          userId: followee.userId,
          username: expect.any(String) as string,
          firstName: 'Ada',
          lastName: 'Lovelace',
        },
      ]);
    });

    it("shows only the caller's own lists", async () => {
      const alice = await seedUser('alice');
      const bob = await seedUser('bob');
      const carol = await seedUser('carol');
      await follow(carol.userId, bob.userId).expect(200);
      await follow(bob.userId, carol.userId).expect(200);

      const aliceFollowers = dataOf<Page>(
        await list(alice.userId, 'followers').expect(200),
      );
      const aliceFollowing = dataOf<Page>(
        await list(alice.userId, 'following').expect(200),
      );

      expect(aliceFollowers.items).toEqual([]);
      expect(aliceFollowing.items).toEqual([]);
    });

    it('defaults to 20 per page and rejects a limit above 50', async () => {
      const owner = await seedUser('limit');
      await ctx.dataSource.query(
        `INSERT INTO follows (follower_user_id, followee_user_id)
         SELECT $1, u.id FROM users u WHERE u.id <> $1`,
        [owner.userId],
      );

      const page = dataOf<Page>(
        await list(owner.userId, 'following').expect(200),
      );
      expect(page.items.length).toBe(20);

      await list(owner.userId, 'following', { limit: 51 }).expect(400);
      await list(owner.userId, 'following', { limit: 50 }).expect(200);
    });

    it('rejects a malformed cursor with a 400', async () => {
      const owner = await seedUser('badcursor');

      await list(owner.userId, 'followers', { cursor: 'not-a-cursor' }).expect(
        400,
      );
    });
  });

  describe('GET /social/users/:userId/relationship', () => {
    it("returns both follow directions and the other user's counts", async () => {
      const viewer = await seedUser('rv');
      const other = await seedUser('ro');
      const third = await seedUser('rt');
      await follow(viewer.userId, other.userId).expect(200);
      await follow(third.userId, other.userId).expect(200);
      await follow(other.userId, third.userId).expect(200);

      const before = dataOf<Relationship>(
        await relationship(viewer.userId, other.userId).expect(200),
      );
      expect(before).toEqual({
        userId: other.userId,
        follows: true,
        followedBy: false,
        blocked: false,
        followerCount: 2,
        followingCount: 1,
      });

      await follow(other.userId, viewer.userId).expect(200);
      const after = dataOf<Relationship>(
        await relationship(viewer.userId, other.userId).expect(200),
      );
      expect(after).toMatchObject({
        followedBy: true,
        followingCount: 2,
      });
    });

    it('rejects looking up a relationship with yourself with a 400', async () => {
      const viewer = await seedUser('rself');

      const res = await relationship(viewer.userId, viewer.userId).expect(400);

      expect(errorOf(res).code).toBe('SELF_RELATIONSHIP_NOT_ALLOWED');
    });

    it('returns 404 for a user that does not exist', async () => {
      const viewer = await seedUser('rnf');

      const res = await relationship(viewer.userId, randomUUID()).expect(404);

      expect(errorOf(res).code).toBe('USER_NOT_FOUND');
    });

    it('never exposes tier or legal name', async () => {
      const viewer = await seedUser('rpriv');
      const other = await seedUser('rprivo', 'tier3');
      await follow(viewer.userId, other.userId).expect(200);

      const responses = await Promise.all([
        relationship(viewer.userId, other.userId),
        list(viewer.userId, 'following'),
        list(other.userId, 'followers'),
        follow(viewer.userId, other.userId),
      ]);

      for (const res of responses) {
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/tier|kyc|legal/i);
        expect(body).not.toContain('@example.com');
      }
    });
  });

  describe('new_follower notification', () => {
    it('notifies the followee in-app and by push, never by email', async () => {
      const follower = await seedUser('nfa');
      const followee = await seedUser('nfb');
      const token = `push-follow-${followee.userId}`;
      await ctx.notificationService.registerPushToken(
        followee.userId,
        'android',
        token,
      );
      const emailsBefore = ctx.emailAdapter.sent.length;

      await follow(follower.userId, followee.userId).expect(200);
      await waitForQueuesDrained();

      const rows = await ctx.notificationRepo.findBy({
        userId: followee.userId,
        type: 'new_follower',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        title: 'New follower',
        data: { followerUserId: follower.userId },
      });
      expect(rows[0].body).toContain('nfa_follow_');
      expect(
        ctx.pushAdapter.sent.filter((message) => message.token === token),
      ).toHaveLength(1);
      expect(ctx.emailAdapter.sent.length).toBe(emailsBefore);
      expect(
        await ctx.notificationRepo.countBy({
          userId: follower.userId,
          type: 'new_follower',
        }),
      ).toBe(0);
    });

    it('does not stack in-app notifications across follow, unfollow, follow, and unfollow never notifies', async () => {
      const follower = await seedUser('dda');
      const followee = await seedUser('ddb');

      await follow(follower.userId, followee.userId).expect(200);
      await waitForQueuesDrained();
      const countAfterFirst = await ctx.notificationRepo.countBy({
        userId: followee.userId,
      });
      expect(countAfterFirst).toBe(1);

      await unfollow(follower.userId, followee.userId).expect(200);
      await waitForQueuesDrained();
      expect(
        await ctx.notificationRepo.countBy({ userId: followee.userId }),
      ).toBe(1);
      expect(
        await ctx.notificationRepo.countBy({ userId: follower.userId }),
      ).toBe(0);

      await follow(follower.userId, followee.userId).expect(200);
      await waitForQueuesDrained();
      expect(
        await ctx.notificationRepo.countBy({
          userId: followee.userId,
          type: 'new_follower',
        }),
      ).toBe(1);
    });

    it('does not notify again on an idempotent re-follow', async () => {
      const follower = await seedUser('ida');
      const followee = await seedUser('idb');
      const token = `push-refollow-${followee.userId}`;
      await ctx.notificationService.registerPushToken(
        followee.userId,
        'ios',
        token,
      );

      await follow(follower.userId, followee.userId).expect(200);
      await follow(follower.userId, followee.userId).expect(200);
      await waitForQueuesDrained();

      expect(
        ctx.pushAdapter.sent.filter((message) => message.token === token),
      ).toHaveLength(1);
    });
  });
});
