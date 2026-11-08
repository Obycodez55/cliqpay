import { randomUUID } from 'crypto';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  seedTransferUser,
} from './support/transfers-test-context';
import { SocialService } from '../../src/modules/social/social.service';
import { insertTransferPost } from './support/social-post-fixtures';

jest.setTimeout(180_000);

describe('Post publicity under concurrent writers', () => {
  let ctx: TransfersTestContext;
  let social: SocialService;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0);
    social = ctx.app.get(SocialService);
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedUser(prefix: string): Promise<string> {
    idSeq += 1;
    const n = idSeq;
    const { userId } = await seedTransferUser(ctx, {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348077${String(500_000 + n).padStart(6, '0')}`,
      username: `${prefix}_pub_${n}`,
      kycTier: 'tier1',
    });
    return userId;
  }

  async function expectFlagsMatchRecomputation(postId: string): Promise<void> {
    const [post]: { visibility: string; is_public: boolean }[] =
      await ctx.dataSource.query(
        'SELECT visibility, is_public FROM posts WHERE id = $1',
        [postId],
      );
    const participants: { hidden: boolean; post_is_public: boolean }[] =
      await ctx.dataSource.query(
        'SELECT hidden, post_is_public FROM post_participants WHERE post_id = $1',
        [postId],
      );
    const expected =
      post.visibility === 'public' && !participants.some((p) => p.hidden);
    expect(post.is_public).toBe(expected);
    for (const participant of participants) {
      expect(participant.post_is_public).toBe(expected);
    }
  }

  it('keeps is_public and every post_is_public equal to a recomputation when a visibility toggle races a hide', async () => {
    const sender = await seedUser('sender');
    const recipient = await seedUser('recipient');

    for (let i = 0; i < 40; i += 1) {
      const postId = await insertTransferPost(ctx.dataSource, {
        sender,
        recipient,
        visibility: i % 2 === 0 ? 'public' : 'private',
        hidden: i % 3 === 0,
      });
      await social.setHidden(recipient, postId, i % 3 === 0);

      await Promise.all([
        social.setVisibility(
          sender,
          postId,
          i % 2 === 0 ? 'private' : 'public',
        ),
        social.setHidden(recipient, postId, i % 3 !== 0),
      ]);

      await expectFlagsMatchRecomputation(postId);
    }
  });

  it('keeps the flags consistent across many interleaved toggles and hides on one post', async () => {
    const sender = await seedUser('sender');
    const recipient = await seedUser('recipient');
    const postId = await insertTransferPost(ctx.dataSource, {
      sender,
      recipient,
    });

    for (let round = 0; round < 10; round += 1) {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          i % 2 === 0
            ? social.setVisibility(
                sender,
                postId,
                (round + i) % 4 === 0 ? 'private' : 'public',
              )
            : social.setHidden(recipient, postId, (round + i) % 3 === 0),
        ),
      );
      await expectFlagsMatchRecomputation(postId);
    }
  });

  it('writes consistent flags when a post is created through the service', async () => {
    const sender = await seedUser('sender');
    const recipient = await seedUser('recipient');
    const postId = randomUUID();
    await ctx.dataSource.transaction((manager) =>
      social.recordTransferPost(manager, {
        transactionId: postId,
        senderUserId: sender,
        recipientUserId: recipient,
        note: null,
        visibility: 'public',
      }),
    );

    const [post]: { is_public: boolean }[] = await ctx.dataSource.query(
      'SELECT is_public FROM posts WHERE id = $1',
      [postId],
    );
    expect(post.is_public).toBe(true);
    await expectFlagsMatchRecomputation(postId);
  });
});
