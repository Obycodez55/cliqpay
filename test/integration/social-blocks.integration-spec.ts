import { randomUUID } from 'crypto';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  BLOCK_DIRECTIONS as directions,
  SeededUser,
  createSocialBlocksTestHelpers,
  expectNoBlockedWording,
  waitFor,
} from './support/social-blocks-test-helpers';
import { dataOf, errorOf } from './support/api-response';
import { Follow } from '../../src/modules/social/entities/follow.entity';
import { Block } from '../../src/modules/social/entities/block.entity';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import {
  NEW_FOLLOWER_EVENT,
  NewFollowerEventPayload,
} from '../../src/shared/events/domain-events';

jest.setTimeout(180_000);

interface Page {
  items: { userId: string }[];
  nextCursor: string | null;
}

describe('Social blocks', () => {
  let ctx: TransfersTestContext;
  const {
    tokenFor,
    http,
    seedUser,
    block,
    unblock,
    follow,
    blockBetween,
    waitForQueuesDrained,
  } = createSocialBlocksTestHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0);
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  const followRepo = () => ctx.dataSource.getRepository(Follow);
  const blockRepo = () => ctx.dataSource.getRepository(Block);

  function listBlocks(
    userId: string,
    query: Record<string, string | number> = {},
  ) {
    return http()
      .get('/social/blocks')
      .query(query)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);
  }

  function relationship(viewerId: string, otherId: string) {
    return http()
      .get(`/social/users/${otherId}/relationship`)
      .set('Authorization', `Bearer ${tokenFor(viewerId)}`);
  }

  describe('PUT and DELETE /social/blocks/:userId', () => {
    it('blocks and unblocks idempotently', async () => {
      const blocker = await seedUser('ba');
      const blocked = await seedUser('bb');

      const first = await block(blocker.userId, blocked.userId).expect(200);
      expect(dataOf(first)).toEqual({ userId: blocked.userId, blocked: true });
      await block(blocker.userId, blocked.userId).expect(200);
      expect(await blockRepo().countBy({ blockerUserId: blocker.userId })).toBe(
        1,
      );

      const removed = await unblock(blocker.userId, blocked.userId).expect(200);
      expect(dataOf(removed)).toEqual({
        userId: blocked.userId,
        blocked: false,
      });
      await unblock(blocker.userId, blocked.userId).expect(200);
      expect(await blockRepo().countBy({ blockerUserId: blocker.userId })).toBe(
        0,
      );
    });

    it('works at KYC Tier 0', async () => {
      const blocker = await seedUser('t0a', 'tier0');
      const blocked = await seedUser('t0b', 'tier0');

      await block(blocker.userId, blocked.userId).expect(200);
      const page = dataOf<Page>(await listBlocks(blocker.userId).expect(200));
      expect(page.items.map((item) => item.userId)).toEqual([blocked.userId]);
      await unblock(blocker.userId, blocked.userId).expect(200);
    });

    it('rejects blocking yourself with a 400', async () => {
      const user = await seedUser('bself');

      const res = await block(user.userId, user.userId).expect(400);

      expect(errorOf(res).code).toBe('SELF_BLOCK_NOT_ALLOWED');
    });

    it('rejects blocking a user that does not exist with a 404', async () => {
      const user = await seedUser('bghost');

      const res = await block(user.userId, randomUUID()).expect(404);

      expect(errorOf(res).code).toBe('USER_NOT_FOUND');
    });

    it('enforces the database CHECK against self-blocks', async () => {
      const user = await seedUser('bcheck');

      await expect(
        blockRepo().insert({
          blockerUserId: user.userId,
          blockedUserId: user.userId,
        }),
      ).rejects.toThrow(/CHK_blocks_not_self/);
    });
  });

  describe('GET /social/blocks', () => {
    it("lists only the caller's own blocks, newest first, keyset paginated", async () => {
      const owner = await seedUser('lowner');
      const other = await seedUser('lother');
      const targets = await Promise.all([
        seedUser('lt1'),
        seedUser('lt2'),
        seedUser('lt3'),
      ]);
      for (const target of targets) {
        await block(owner.userId, target.userId).expect(200);
      }
      await block(targets[0].userId, owner.userId).expect(200);
      const stamps = ['2026-01-01', '2026-01-03', '2026-01-02'];
      for (const [i, target] of targets.entries()) {
        await blockRepo().update(
          { blockerUserId: owner.userId, blockedUserId: target.userId },
          { createdAt: new Date(`${stamps[i]}T00:00:00Z`) },
        );
      }

      const first = dataOf<Page>(
        await listBlocks(owner.userId, { limit: 2 }).expect(200),
      );
      expect(first.items.map((item) => item.userId)).toEqual([
        targets[1].userId,
        targets[2].userId,
      ]);
      const second = dataOf<Page>(
        await listBlocks(owner.userId, {
          limit: 2,
          cursor: first.nextCursor!,
        }).expect(200),
      );
      expect(second.items.map((item) => item.userId)).toEqual([
        targets[0].userId,
      ]);
      expect(second.nextCursor).toBeNull();

      const others = dataOf<Page>(await listBlocks(other.userId).expect(200));
      expect(others.items).toEqual([]);
      const blockedSide = dataOf<Page>(
        await listBlocks(targets[1].userId).expect(200),
      );
      expect(blockedSide.items).toEqual([]);
    });
  });

  describe('follows', () => {
    it('removes follows in both directions when a block is created', async () => {
      const a = await seedUser('fra');
      const b = await seedUser('frb');
      const bystander = await seedUser('frc');
      await follow(a.userId, b.userId).expect(200);
      await follow(b.userId, a.userId).expect(200);
      await follow(bystander.userId, a.userId).expect(200);

      await block(a.userId, b.userId).expect(200);

      expect(
        await followRepo().countBy({
          followerUserId: a.userId,
          followeeUserId: b.userId,
        }),
      ).toBe(0);
      expect(
        await followRepo().countBy({
          followerUserId: b.userId,
          followeeUserId: a.userId,
        }),
      ).toBe(0);
      expect(
        await followRepo().countBy({
          followerUserId: bystander.userId,
          followeeUserId: a.userId,
        }),
      ).toBe(1);
    });

    it('answers the blocked user with a generic rejection, not a 404, since the user still resolves elsewhere', async () => {
      const blocker = await seedUser('fna');
      const blocked = await seedUser('fnb');
      await block(blocker.userId, blocked.userId).expect(200);

      const res = await follow(blocked.userId, blocker.userId).expect(422);

      expect(errorOf(res).code).toBe('INTERACTION_UNAVAILABLE');
      expectNoBlockedWording(res);
      await relationship(blocked.userId, blocker.userId).expect(200);
      expect(
        await followRepo().countBy({ followerUserId: blocked.userId }),
      ).toBe(0);
    });

    it('tells the blocker to unblock first', async () => {
      const blocker = await seedUser('fua');
      const blocked = await seedUser('fub');
      await block(blocker.userId, blocked.userId).expect(200);

      const res = await follow(blocker.userId, blocked.userId).expect(422);

      expect(errorOf(res).code).toBe('FOLLOW_REQUIRES_UNBLOCK');
      expect(errorOf(res).message).toMatch(/unblock/i);
      expect(
        await followRepo().countBy({ followerUserId: blocker.userId }),
      ).toBe(0);
    });

    it('allows following again in both directions after unblocking', async () => {
      const blocker = await seedUser('fga');
      const blocked = await seedUser('fgb');
      await block(blocker.userId, blocked.userId).expect(200);
      await unblock(blocker.userId, blocked.userId).expect(200);

      await follow(blocker.userId, blocked.userId).expect(200);
      await follow(blocked.userId, blocker.userId).expect(200);
    });

    async function lockWaiters(): Promise<number> {
      const [{ count }] = await ctx.dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      return count;
    }

    it.each(directions)(
      'never leaves a follow standing when a block lands mid-follow and $name',
      async ({ blockerIndex }) => {
        const follower = await seedUser('racea');
        const followee = await seedUser('raceb');
        const pair: [SeededUser, SeededUser] = [follower, followee];
        // An uncommitted row on the same key parks the follow at its insert,
        // after it has already looked for a block.
        const holder = ctx.dataSource.createQueryRunner();
        await holder.connect();
        await holder.startTransaction();
        await holder.query(
          'INSERT INTO follows (follower_user_id, followee_user_id) VALUES ($1, $2)',
          [follower.userId, followee.userId],
        );

        const following = ctx.socialService.follow(
          follower.userId,
          followee.userId,
        );
        await waitFor(async () => (await lockWaiters()) === 1);

        let blockSettled = false;
        const blocking = ctx.socialService
          .block(pair[blockerIndex].userId, pair[1 - blockerIndex].userId)
          .finally(() => {
            blockSettled = true;
          });
        await waitFor(async () => blockSettled || (await lockWaiters()) === 2);

        await holder.rollbackTransaction();
        await holder.release();
        await Promise.allSettled([following, blocking]);

        expect(
          await followRepo().countBy([
            {
              followerUserId: follower.userId,
              followeeUserId: followee.userId,
            },
            {
              followerUserId: followee.userId,
              followeeUserId: follower.userId,
            },
          ]),
        ).toBe(0);
        expect(
          await blockRepo().countBy({
            blockerUserId: pair[blockerIndex].userId,
          }),
        ).toBe(1);
      },
    );
  });

  describe('relationship view', () => {
    it('shows blocked to the blocker only', async () => {
      const blocker = await seedUser('rba');
      const blocked = await seedUser('rbb');
      await follow(blocked.userId, blocker.userId).expect(200);
      await block(blocker.userId, blocked.userId).expect(200);

      const blockerView = dataOf<Record<string, unknown>>(
        await relationship(blocker.userId, blocked.userId).expect(200),
      );
      expect(blockerView).toMatchObject({
        blocked: true,
        follows: false,
        followedBy: false,
      });

      const blockedRes = await relationship(
        blocked.userId,
        blocker.userId,
      ).expect(200);
      expect(dataOf(blockedRes)).toEqual({
        userId: blocker.userId,
        follows: false,
        followedBy: false,
        blocked: false,
        followerCount: 0,
        followingCount: 0,
      });
    });

    it('shows blocked false when there is no block', async () => {
      const a = await seedUser('rna');
      const b = await seedUser('rnb');

      const view = dataOf<Record<string, unknown>>(
        await relationship(a.userId, b.userId).expect(200),
      );

      expect(view.blocked).toBe(false);
    });
  });

  describe('new_follower notification', () => {
    async function publishNewFollower(
      followerId: string,
      followeeId: string,
    ): Promise<void> {
      await ctx.app
        .get(EventBusService)
        .publish<string, NewFollowerEventPayload>({
          name: NEW_FOLLOWER_EVENT,
          payload: {
            userId: followeeId,
            followerUserId: followerId,
            followerUsername: 'someone',
          },
          occurredAt: new Date(),
        });
    }

    it.each(directions)(
      'is skipped at dispatch time when $name',
      async ({ blockerIndex }) => {
        const follower = await seedUser('nfa');
        const followee = await seedUser('nfb');
        const token = `push-block-${followee.userId}`;
        await ctx.notificationService.registerPushToken(
          followee.userId,
          'android',
          token,
        );
        await blockBetween([follower, followee], blockerIndex);

        await publishNewFollower(follower.userId, followee.userId);
        await waitForQueuesDrained();

        expect(
          await ctx.notificationRepo.countBy({
            userId: followee.userId,
            type: 'new_follower',
          }),
        ).toBe(0);
        expect(
          ctx.pushAdapter.sent.filter((message) => message.token === token),
        ).toHaveLength(0);
      },
    );

    it('is still delivered when there is no block', async () => {
      const follower = await seedUser('nda');
      const followee = await seedUser('ndb');

      await publishNewFollower(follower.userId, followee.userId);
      await waitForQueuesDrained();

      expect(
        await ctx.notificationRepo.countBy({
          userId: followee.userId,
          type: 'new_follower',
        }),
      ).toBe(1);
    });
  });
});
