import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf, errorOf } from './support/api-response';
import { Follow } from '../../src/modules/social/entities/follow.entity';
import { PostComment } from '../../src/modules/social/entities/post-comment.entity';
import {
  TestPostOptions,
  insertTransferPost,
} from './support/social-post-fixtures';
import { KycTier } from '../../src/modules/users/users.service';
import {
  DOMAIN_EVENTS_QUEUE,
  EventBusService,
} from '../../src/shared/events/event-bus.service';
import {
  POST_COMMENT_EVENT,
  PostCommentEventPayload,
} from '../../src/shared/events/domain-events';
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

interface CommentItem {
  id: string;
  author: {
    userId: string;
    username: string;
    firstName: string;
    lastName: string;
  };
  body: string;
  createdAt: string;
}

interface CommentPage {
  items: CommentItem[];
  nextCursor: string | null;
}

interface FeedPost {
  transactionId: string;
  commentCount: number;
}

describe('Social comments', () => {
  let ctx: TransfersTestContext;
  let jwtService: JwtService;
  let idSeq = 0;

  beforeAll(async () => {
    // In-memory throttler storage for the per-user comment limit, without
    // the global IP-keyed guard that would cap this whole spec's traffic.
    ctx = await createTransfersTestContext(0, [
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ]);
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
      phone: `+2348068${String(500_000 + n).padStart(6, '0')}`,
      username: `${prefix}_cmt_${n}`,
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

  function insertPost(options: TestPostOptions): Promise<string> {
    return insertTransferPost(ctx.dataSource, options);
  }

  async function seedPublicPost() {
    const sender = await seedUser('sender');
    const recipient = await seedUser('recipient');
    const transactionId = await insertPost({ sender, recipient });
    return { sender, recipient, transactionId };
  }

  async function seedFollowedPost() {
    const post = await seedPublicPost();
    const viewer = await seedUser('viewer');
    await follow(viewer, post.sender);
    return { ...post, viewer };
  }

  function http() {
    return request(ctx.app.getHttpServer());
  }

  function comment(userId: string, transactionId: string, body: unknown) {
    return http()
      .post(`/social/posts/${transactionId}/comments`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`)
      .send({ body });
  }

  async function commentId(
    userId: string,
    transactionId: string,
    body = 'nice one',
  ): Promise<string> {
    const res = await comment(userId, transactionId, body).expect(201);
    return dataOf<CommentItem>(res).id;
  }

  function list(userId: string, transactionId: string, cursor?: string) {
    return http()
      .get(`/social/posts/${transactionId}/comments`)
      .query(cursor ? { cursor } : {})
      .set('Authorization', `Bearer ${tokenFor(userId)}`);
  }

  async function listAll(
    userId: string,
    transactionId: string,
  ): Promise<CommentItem[]> {
    return dataOf<CommentPage>(await list(userId, transactionId).expect(200))
      .items;
  }

  function remove(userId: string, commentId: string) {
    return http()
      .delete(`/social/comments/${commentId}`)
      .set('Authorization', `Bearer ${tokenFor(userId)}`);
  }

  async function postView(
    viewerId: string,
    transactionId: string,
  ): Promise<FeedPost> {
    return dataOf<FeedPost>(
      await http()
        .get(`/social/posts/${transactionId}`)
        .set('Authorization', `Bearer ${tokenFor(viewerId)}`)
        .expect(200),
    );
  }

  async function feed(viewerId: string): Promise<FeedPost[]> {
    const res = await http()
      .get('/social/feed')
      .query({ limit: 50 })
      .set('Authorization', `Bearer ${tokenFor(viewerId)}`)
      .expect(200);
    return dataOf<{ items: FeedPost[] }>(res).items;
  }

  function setVisibility(
    senderId: string,
    transactionId: string,
    visibility: 'public' | 'private',
  ) {
    return http()
      .patch(`/social/posts/${transactionId}/visibility`)
      .set('Authorization', `Bearer ${tokenFor(senderId)}`)
      .send({ visibility })
      .expect(200);
  }

  function block(blockerId: string, blockedId: string) {
    return http()
      .put(`/social/blocks/${blockedId}`)
      .set('Authorization', `Bearer ${tokenFor(blockerId)}`)
      .expect(200);
  }

  async function storedComment(id: string): Promise<PostComment> {
    return ctx.dataSource.getRepository(PostComment).findOneByOrFail({ id });
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

  function commentNotifications(userId: string) {
    return ctx.notificationRepo.findBy({ userId, type: 'post_comment' });
  }

  describe('post_comments table', () => {
    it('rejects a comment on a post that does not exist', async () => {
      const user = await seedUser('fk');

      await expect(
        ctx.dataSource.query(
          `INSERT INTO post_comments (post_id, author_user_id, body) VALUES ($1, $2, 'hi')`,
          [randomUUID(), user],
        ),
      ).rejects.toThrow(/FK_post_comments_post_id/);
    });
  });

  describe('POST /social/posts/:transactionId/comments', () => {
    it('stores a trimmed comment and returns it with the author', async () => {
      const { viewer, transactionId } = await seedFollowedPost();

      const res = await comment(
        viewer,
        transactionId,
        '  great lunch  ',
      ).expect(201);

      const created = dataOf<CommentItem>(res);
      expect(created).toMatchObject({
        body: 'great lunch',
        author: { userId: viewer },
      });
      expect(created.author.username).toMatch(/^viewer_cmt_/);
      expect(Object.keys(created.author).sort()).toEqual([
        'firstName',
        'lastName',
        'userId',
        'username',
      ]);
      const stored = await storedComment(created.id);
      expect(stored).toMatchObject({
        postId: transactionId,
        authorUserId: viewer,
        body: 'great lunch',
        deletedAt: null,
        deletedByUserId: null,
      });
    });

    it('lets either participant comment on their own post', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();

      await comment(sender, transactionId, 'thanks').expect(201);
      await comment(recipient, transactionId, 'anytime').expect(201);

      expect(
        (await listAll(sender, transactionId)).map((item) => item.body),
      ).toEqual(['thanks', 'anytime']);
    });

    it.each([
      { name: 'empty', body: '' },
      { name: 'only whitespace', body: '   \n\t ' },
      { name: 'only zero-width characters', body: '\u200B' },
      {
        name: 'only zero-width characters and whitespace',
        body: ' \u200D\u200C\u2060\uFEFF ',
      },
      { name: 'over 280 characters', body: 'a'.repeat(281) },
      { name: 'not a string', body: 42 },
    ])('rejects a body that is $name', async ({ body }) => {
      const { viewer, transactionId } = await seedFollowedPost();

      const res = await comment(viewer, transactionId, body).expect(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('keeps emoji joiners in a body that has visible text', async () => {
      const { viewer, transactionId } = await seedFollowedPost();

      const res = await comment(
        viewer,
        transactionId,
        '  great lunch \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67  ',
      ).expect(201);
      expect(dataOf<CommentItem>(res).body).toBe(
        'great lunch \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67',
      );
    });

    it('accepts exactly 280 characters, counting an emoji as one, after trimming', async () => {
      const { viewer, transactionId } = await seedFollowedPost();
      const body = '❤'.repeat(140) + '🔥'.repeat(140);

      const res = await comment(viewer, transactionId, `  ${body}  `).expect(
        201,
      );
      expect(dataOf<CommentItem>(res).body).toBe(body);
    });

    describe('returns 404 POST_NOT_FOUND when the caller cannot comment', () => {
      async function expectNotFound(userId: string, transactionId: string) {
        const res = await comment(userId, transactionId, 'hello').expect(404);
        expect(errorOf(res).code).toBe('POST_NOT_FOUND');
      }

      it('for a post that does not exist', async () => {
        await expectNotFound(await seedUser('ghost'), randomUUID());
      });

      it('for a public post by people the caller does not follow', async () => {
        const { transactionId } = await seedPublicPost();
        await expectNotFound(await seedUser('stranger'), transactionId);
      });

      it('for a followed user’s private post', async () => {
        const sender = await seedUser('sender');
        const recipient = await seedUser('recipient');
        const viewer = await seedUser('viewer');
        await follow(viewer, sender);
        const transactionId = await insertPost({
          sender,
          recipient,
          visibility: 'private',
        });
        await expectNotFound(viewer, transactionId);
      });

      it.each([
        { name: 'the viewer blocked the recipient', viewerBlocks: true },
        { name: 'the recipient blocked the viewer', viewerBlocks: false },
      ])(
        'across a block with either participant when $name',
        async ({ viewerBlocks }) => {
          const { recipient, viewer, transactionId } = await seedFollowedPost();
          if (viewerBlocks) {
            await block(viewer, recipient);
          } else {
            await block(recipient, viewer);
          }

          await expectNotFound(viewer, transactionId);
        },
      );
    });

    it.each([
      { name: 'they blocked the counterparty', participantBlocks: true },
      { name: 'the counterparty blocked them', participantBlocks: false },
    ])(
      'rejects a participant commenting across a block when $name',
      async ({ participantBlocks }) => {
        const { sender, recipient, transactionId } = await seedPublicPost();
        if (participantBlocks) {
          await block(recipient, sender);
        } else {
          await block(sender, recipient);
        }

        await list(recipient, transactionId).expect(200);
        const res = await comment(recipient, transactionId, 'hello').expect(
          422,
        );
        expect(errorOf(res).code).toBe('INTERACTION_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/block/i);
        expect(
          await ctx.dataSource
            .getRepository(PostComment)
            .countBy({ authorUserId: recipient }),
        ).toBe(0);
      },
    );

    it('sees a block committed while the comment waits on the pair lock', async () => {
      const { sender, viewer, transactionId } = await seedFollowedPost();
      const [low, high] = [viewer, sender].sort();
      const runner = ctx.dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `social-pair:${low}:${high}`,
        ]);
        await runner.query(
          'INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)',
          [sender, viewer],
        );

        const pending = comment(viewer, transactionId, 'too late').then(
          (res) => res,
        );
        await waitFor(async () => {
          const waiting: unknown[] = await ctx.dataSource.query(
            `SELECT 1 FROM pg_locks
             WHERE locktype = 'advisory' AND NOT granted
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          );
          return waiting.length > 0;
        });
        await runner.commitTransaction();

        const res = await pending;
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('POST_NOT_FOUND');
      } finally {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction();
        }
        await runner.release();
      }
      expect(
        await ctx.dataSource
          .getRepository(PostComment)
          .countBy({ authorUserId: viewer }),
      ).toBe(0);
    });

    it('throttles at 10 a minute per user, without affecting other users', async () => {
      const { sender, viewer, transactionId } = await seedFollowedPost();

      for (let i = 0; i < 10; i++) {
        await comment(viewer, transactionId, `comment ${i}`).expect(201);
      }
      await comment(viewer, transactionId, 'one too many').expect(429);

      await comment(sender, transactionId, 'still fine').expect(201);
      expect(
        await ctx.dataSource
          .getRepository(PostComment)
          .countBy({ authorUserId: viewer }),
      ).toBe(10);
    });
  });

  describe('GET /social/posts/:transactionId/comments', () => {
    it('pages oldest first, 20 at a time, breaking timestamp ties by id', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();
      const postId = transactionId;
      // Pairs share a timestamp so a page boundary falls inside a tie.
      for (let i = 0; i < 45; i++) {
        await ctx.dataSource.query(
          `INSERT INTO post_comments (post_id, author_user_id, body, created_at)
          VALUES ($1, $2, $3, '2026-01-01T00:00:00Z'::timestamptz + make_interval(secs => $4))`,
          [postId, i % 2 ? sender : recipient, `c${i}`, Math.floor(i / 2)],
        );
      }
      const expected: { id: string }[] = await ctx.dataSource.query(
        'SELECT id FROM post_comments WHERE post_id = $1 ORDER BY created_at, id',
        [postId],
      );

      const seen: string[] = [];
      const pageSizes: number[] = [];
      let cursor: string | undefined;
      do {
        const page = dataOf<CommentPage>(
          await list(sender, transactionId, cursor).expect(200),
        );
        pageSizes.push(page.items.length);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      expect(pageSizes).toEqual([20, 20, 5]);
      expect(seen).toEqual(expected.map((row) => row.id));
    });

    it('rejects a malformed cursor', async () => {
      const { sender, transactionId } = await seedPublicPost();
      await list(sender, transactionId, 'not-a-cursor').expect(400);
    });

    it('leaves out deleted comments', async () => {
      const { sender, viewer, transactionId } = await seedFollowedPost();
      const kept = await commentId(viewer, transactionId, 'kept');
      const gone = await commentId(viewer, transactionId, 'gone');
      await remove(viewer, gone).expect(204);

      expect(
        (await listAll(sender, transactionId)).map((item) => item.id),
      ).toEqual([kept]);
    });

    it('hides comments by users the caller has blocked, from the caller only', async () => {
      const { sender, recipient, viewer, transactionId } =
        await seedFollowedPost();
      const other = await seedUser('other');
      await follow(other, sender);
      await commentId(other, transactionId, 'from other');
      const fromViewer = await commentId(viewer, transactionId, 'from viewer');

      await block(viewer, other);

      expect(
        (await listAll(viewer, transactionId)).map((item) => item.id),
      ).toEqual([fromViewer]);
      expect(await listAll(recipient, transactionId)).toHaveLength(2);
    });

    it('hides comments by a user a participant blocked, from every reader', async () => {
      const { sender, recipient, viewer, transactionId } =
        await seedFollowedPost();
      const harasser = await seedUser('harasser');
      await follow(harasser, sender);
      await commentId(harasser, transactionId, 'harass');
      const kept = await commentId(viewer, transactionId, 'kind words');

      await block(sender, harasser);

      for (const reader of [sender, recipient, viewer]) {
        expect(
          (await listAll(reader, transactionId)).map((item) => item.id),
        ).toEqual([kept]);
        expect((await postView(reader, transactionId)).commentCount).toBe(1);
      }
      const [item] = await feed(viewer);
      expect(item.commentCount).toBe(1);
    });

    it('returns 404 POST_NOT_FOUND when the caller cannot read the post', async () => {
      const { transactionId } = await seedPublicPost();

      const res = await list(await seedUser('stranger'), transactionId).expect(
        404,
      );
      expect(errorOf(res).code).toBe('POST_NOT_FOUND');
      await list(await seedUser('ghost'), randomUUID()).expect(404);
    });
  });

  describe('DELETE /social/comments/:commentId', () => {
    it('lets the author delete their comment, recording them as the deleter', async () => {
      const { viewer, transactionId } = await seedFollowedPost();
      const id = await commentId(viewer, transactionId);

      await remove(viewer, id).expect(204);

      const stored = await storedComment(id);
      expect(stored.deletedAt).toBeInstanceOf(Date);
      expect(stored.deletedByUserId).toBe(viewer);
    });

    it.each(['sender', 'recipient'] as const)(
      'lets the %s delete someone else’s comment on their post',
      async (role) => {
        const post = await seedFollowedPost();
        const id = await commentId(post.viewer, post.transactionId);

        await remove(post[role], id).expect(204);

        const stored = await storedComment(id);
        expect(stored.deletedByUserId).toBe(post[role]);
        expect(stored.body).toBe('nice one');
        expect(await listAll(post.viewer, post.transactionId)).toEqual([]);
      },
    );

    describe('returns 404 COMMENT_NOT_FOUND', () => {
      async function expectNotFound(userId: string, id: string) {
        const res = await remove(userId, id).expect(404);
        expect(errorOf(res).code).toBe('COMMENT_NOT_FOUND');
      }

      it('for anyone other than the author or a participant', async () => {
        const { sender, viewer, transactionId } = await seedFollowedPost();
        const id = await commentId(viewer, transactionId);
        const bystander = await seedUser('bystander');
        await follow(bystander, sender);

        await expectNotFound(bystander, id);
        expect((await storedComment(id)).deletedAt).toBeNull();
      });

      it('for a comment that does not exist', async () => {
        await expectNotFound(await seedUser('ghost'), randomUUID());
      });

      it('for a comment that is already deleted, keeping the first deleter', async () => {
        const { sender, viewer, transactionId } = await seedFollowedPost();
        const id = await commentId(viewer, transactionId);
        await remove(sender, id).expect(204);

        await expectNotFound(viewer, id);
        await expectNotFound(sender, id);
        expect((await storedComment(id)).deletedByUserId).toBe(sender);
      });
    });

    it('lets the author delete after losing sight of the post', async () => {
      const { sender, viewer, transactionId } = await seedFollowedPost();
      const id = await commentId(viewer, transactionId);
      await setVisibility(sender, transactionId, 'private');

      await remove(viewer, id).expect(204);
      expect((await storedComment(id)).deletedByUserId).toBe(viewer);
    });

    it('lets a participant delete a comment by someone they have since blocked', async () => {
      const { recipient, viewer, transactionId } = await seedFollowedPost();
      const id = await commentId(viewer, transactionId);
      await block(recipient, viewer);

      await remove(recipient, id).expect(204);
      expect((await storedComment(id)).deletedByUserId).toBe(recipient);
    });
  });

  it('rejects Tier 0 callers with KYC_VERIFICATION_REQUIRED on every endpoint', async () => {
    const sender = await seedUser('sender', 'tier0');
    const recipient = await seedUser('recipient');
    const transactionId = await insertPost({ sender, recipient });
    const id = await commentId(recipient, transactionId);

    for (const res of [
      await comment(sender, transactionId, 'hi').expect(422),
      await list(sender, transactionId).expect(422),
      await remove(sender, id).expect(422),
    ]) {
      expect(errorOf(res).code).toBe('KYC_VERIFICATION_REQUIRED');
    }
    expect((await storedComment(id)).deletedAt).toBeNull();
  });

  describe('commentCount in the feed and post view', () => {
    it('counts readable comments per post across a page', async () => {
      const sender = await seedUser('sender');
      const recipient = await seedUser('recipient');
      const first = await insertPost({ sender, recipient });
      const second = await insertPost({ sender, recipient });
      const third = await insertPost({ sender, recipient });
      const viewer = await seedUser('viewer');
      const other = await seedUser('other');
      await follow(viewer, sender);
      await follow(other, sender);

      await commentId(viewer, first);
      await commentId(other, first);
      const deleted = await commentId(viewer, first);
      await remove(viewer, deleted).expect(204);
      await commentId(other, second);

      const counts = async (userId: string) =>
        new Map(
          (await feed(userId)).map((item) => [
            item.transactionId,
            item.commentCount,
          ]),
        );
      expect(await counts(viewer)).toEqual(
        new Map([
          [first, 2],
          [second, 1],
          [third, 0],
        ]),
      );

      await block(viewer, other);

      expect(await counts(viewer)).toEqual(
        new Map([
          [first, 1],
          [second, 0],
          [third, 0],
        ]),
      );
      expect((await postView(viewer, first)).commentCount).toBe(1);
      expect((await postView(sender, first)).commentCount).toBe(2);
    });
  });

  describe('when a post goes private', () => {
    it('keeps its comments for the participants only, and restores them when it goes public again', async () => {
      const { sender, recipient, viewer, transactionId } =
        await seedFollowedPost();
      const fromViewer = await commentId(viewer, transactionId, 'viewer');
      const fromRecipient = await commentId(recipient, transactionId, 'mine');
      const expected = [fromViewer, fromRecipient];

      await setVisibility(sender, transactionId, 'private');

      expect(errorOf(await list(viewer, transactionId).expect(404)).code).toBe(
        'POST_NOT_FOUND',
      );
      await comment(viewer, transactionId, 'hello?').expect(404);
      for (const participant of [sender, recipient]) {
        expect(
          (await listAll(participant, transactionId)).map((item) => item.id),
        ).toEqual(expected);
        expect((await postView(participant, transactionId)).commentCount).toBe(
          2,
        );
      }
      await comment(sender, transactionId, 'just us').expect(201);

      await setVisibility(sender, transactionId, 'public');

      const restored = await listAll(viewer, transactionId);
      expect(restored.map((item) => item.body)).toEqual([
        'viewer',
        'mine',
        'just us',
      ]);
      expect((await postView(viewer, transactionId)).commentCount).toBe(3);
    });
  });

  describe('post_comment notification', () => {
    it('notifies both participants in-app and by push, keyed on the comment, and not the commenter', async () => {
      const { sender, recipient, viewer, transactionId } =
        await seedFollowedPost();
      const tokens = new Map<string, string>();
      for (const userId of [sender, recipient, viewer]) {
        const token = `push-cmt-${userId}`;
        tokens.set(userId, token);
        await ctx.notificationService.registerPushToken(userId, 'ios', token);
      }

      const id = await commentId(viewer, transactionId);
      await waitForQueuesDrained();

      for (const participant of [sender, recipient]) {
        const rows = await commentNotifications(participant);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          title: 'New comment',
          data: { transactionId, commentId: id, commenterUserId: viewer },
          dedupeKey: id,
        });
        expect(rows[0].body).toContain('viewer_cmt_');
        expect(
          ctx.pushAdapter.sent.filter(
            (message) => message.token === tokens.get(participant),
          ),
        ).toHaveLength(1);
      }
      expect(await commentNotifications(viewer)).toHaveLength(0);
      expect(
        ctx.pushAdapter.sent.filter(
          (message) => message.token === tokens.get(viewer),
        ),
      ).toHaveLength(0);
    });

    it('notifies only the other participant when a participant comments', async () => {
      const { sender, recipient, transactionId } = await seedPublicPost();

      await commentId(recipient, transactionId);
      await waitForQueuesDrained();

      expect(await commentNotifications(sender)).toHaveLength(1);
      expect(await commentNotifications(recipient)).toHaveLength(0);
    });

    it('sends a notification per comment', async () => {
      const { sender, viewer, transactionId } = await seedFollowedPost();

      await commentId(viewer, transactionId, 'one');
      await commentId(viewer, transactionId, 'two');
      await waitForQueuesDrained();

      expect(await commentNotifications(sender)).toHaveLength(2);
    });

    it('does not notify when a comment is deleted', async () => {
      const { sender, recipient, viewer, transactionId } =
        await seedFollowedPost();
      const id = await commentId(viewer, transactionId);
      await waitForQueuesDrained();
      await ctx.notificationRepo.delete({ type: 'post_comment' });
      const pushesBefore = ctx.pushAdapter.sent.length;

      await remove(sender, id).expect(204);
      await waitForQueuesDrained();

      for (const userId of [sender, recipient, viewer]) {
        expect(await commentNotifications(userId)).toHaveLength(0);
      }
      expect(ctx.pushAdapter.sent.length).toBe(pushesBefore);
    });

    describe('at dispatch time', () => {
      async function publishPostComment(
        userId: string,
        commenterUserId: string,
      ): Promise<void> {
        await ctx.app
          .get(EventBusService)
          .publish<string, PostCommentEventPayload>({
            name: POST_COMMENT_EVENT,
            payload: {
              userId,
              transactionId: randomUUID(),
              postKind: 'transfer',
              commentId: randomUUID(),
              commenterUserId,
              commenterUsername: 'someone',
            },
            occurredAt: new Date(),
          });
      }

      it.each([
        { name: 'the recipient blocked the commenter', recipientBlocks: true },
        { name: 'the commenter blocked the recipient', recipientBlocks: false },
      ])(
        'is skipped on every channel when $name',
        async ({ recipientBlocks }) => {
          const userId = await seedUser('nca');
          const commenter = await seedUser('ncb');
          const token = `push-cmt-skip-${userId}`;
          await ctx.notificationService.registerPushToken(userId, 'ios', token);
          if (recipientBlocks) {
            await block(userId, commenter);
          } else {
            await block(commenter, userId);
          }

          await publishPostComment(userId, commenter);
          await waitForQueuesDrained();

          expect(await commentNotifications(userId)).toHaveLength(0);
          expect(
            ctx.pushAdapter.sent.filter((message) => message.token === token),
          ).toHaveLength(0);
        },
      );

      it('is delivered when there is no block', async () => {
        const userId = await seedUser('ncd');
        const commenter = await seedUser('nce');

        await publishPostComment(userId, commenter);
        await waitForQueuesDrained();

        expect(await commentNotifications(userId)).toHaveLength(1);
      });
    });
  });
});
