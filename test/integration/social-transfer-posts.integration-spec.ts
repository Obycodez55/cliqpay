import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf, errorOf } from './support/api-response';
import { TransactionPost } from '../../src/modules/social/entities/transaction-post.entity';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const AMOUNT = 500_000;

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

interface HistoryItem {
  transactionId: string | null;
  reference: string;
  type: string;
  note: string | null;
}

describe('Social posts for transfers', () => {
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const postRepo = () => ctx.dataSource.getRepository(TransactionPost);

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  async function seedUser(prefix: string, fundMinor?: bigint) {
    idSeq += 1;
    const n = idSeq;
    const user = await seedTransferUser(ctx, {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348044${String(300_000 + n).padStart(6, '0')}`,
      username: `${prefix}_social_${n}`,
    });
    if (fundMinor) {
      await fundWallet(ctx, {
        reference: `cliqpay-social-fund-${user.userId}`,
        walletId: user.walletId,
        netAmountMinor: fundMinor,
      });
    }
    return user;
  }

  function send(senderId: string, body: Record<string, unknown>) {
    return request(ctx.app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${tokenFor(senderId)}`)
      .send({ amount: AMOUNT, pin: '1234', ...body });
  }

  function sendBody(recipientUserId: string, extra: Record<string, unknown>) {
    return {
      recipientUserId,
      reference: `cliqpay-social-${randomUUID()}`,
      ...extra,
    };
  }

  async function createRequest(
    requesterId: string,
    payerId: string,
    note?: string,
  ): Promise<string> {
    const res = await request(ctx.app.getHttpServer())
      .post('/money-requests')
      .set('Authorization', `Bearer ${tokenFor(requesterId)}`)
      .send({ payerUserId: payerId, amount: AMOUNT, note })
      .expect(201);
    return dataOf<{ id: string }>(res).id;
  }

  function pay(
    payerId: string,
    requestId: string,
    body: Record<string, unknown>,
  ) {
    return request(ctx.app.getHttpServer())
      .post(`/money-requests/${requestId}/pay`)
      .set('Authorization', `Bearer ${tokenFor(payerId)}`)
      .send({ pin: '1234', ...body });
  }

  async function transactionIdOf(reference: string): Promise<string> {
    return (await ctx.transactionRepo.findOneByOrFail({ reference })).id;
  }

  describe('POST /transfers — note and visibility', () => {
    it('stores the note on the transfer and writes a post carrying the visibility', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const body = sendBody(recipient.userId, {
        note: 'Thanks for lunch',
        visibility: 'public',
      });

      await send(sender.userId, body).expect(201);

      const transaction = await ctx.transactionRepo.findOneByOrFail({
        reference: body.reference,
      });
      expect(transaction.metadata).toMatchObject({ note: 'Thanks for lunch' });
      const post = await postRepo().findOneByOrFail({
        transactionId: transaction.id,
      });
      expect(post).toMatchObject({
        senderUserId: sender.userId,
        recipientUserId: recipient.userId,
        note: 'Thanks for lunch',
        visibility: 'public',
        hiddenByRecipient: false,
      });
    });

    it('writes a private post with a null note when no note is given', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const body = sendBody(recipient.userId, { visibility: 'private' });

      await send(sender.userId, body).expect(201);

      const transaction = await ctx.transactionRepo.findOneByOrFail({
        reference: body.reference,
      });
      expect(transaction.metadata).not.toHaveProperty('note');
      const post = await postRepo().findOneByOrFail({
        transactionId: transaction.id,
      });
      expect(post).toMatchObject({ note: null, visibility: 'private' });
    });

    it.each([
      ['missing', undefined],
      ['not a known value', 'friends'],
    ])(
      'rejects a visibility that is %s with 400, moving nothing',
      async (_l, visibility) => {
        const sender = await seedUser('sender', 5_000_000n);
        const recipient = await seedUser('recipient');
        const body = sendBody(recipient.userId, { visibility });

        await send(sender.userId, body).expect(400);

        expect(
          await ctx.transactionRepo.findOneBy({ reference: body.reference }),
        ).toBeNull();
      },
    );

    it('rejects a note over 500 characters with 400', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');

      await send(
        sender.userId,
        sendBody(recipient.userId, {
          visibility: 'private',
          note: 'x'.repeat(501),
        }),
      ).expect(400);
    });

    it('counts the 500-character note limit in code points', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const note = '🔥'.repeat(500);
      const body = sendBody(recipient.userId, { visibility: 'private', note });

      await send(sender.userId, body).expect(201);
      await send(
        sender.userId,
        sendBody(recipient.userId, {
          visibility: 'private',
          note: '🔥'.repeat(501),
        }),
      ).expect(400);

      const post = await postRepo().findOneByOrFail({
        transactionId: await transactionIdOf(body.reference),
      });
      expect(post.note).toBe(note);
    });

    it('stores no note when only zero-width characters are left, and keeps emoji joiners in a real note', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const blank = sendBody(recipient.userId, {
        visibility: 'public',
        note: ' \u200B\u200C\u200D\u2060\uFEFF ',
      });
      const padded = sendBody(recipient.userId, {
        visibility: 'public',
        note: ' rent \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67 ',
      });

      await send(sender.userId, blank).expect(201);
      await send(sender.userId, padded).expect(201);

      const blankId = await transactionIdOf(blank.reference);
      expect(
        (await postRepo().findOneByOrFail({ transactionId: blankId })).note,
      ).toBeNull();
      const blankTx = await ctx.transactionRepo.findOneByOrFail({
        id: blankId,
      });
      expect(
        (blankTx.metadata as { note?: string } | null)?.note,
      ).toBeUndefined();
      expect(
        (
          await postRepo().findOneByOrFail({
            transactionId: await transactionIdOf(padded.reference),
          })
        ).note,
      ).toBe('rent 👨‍👩‍👧');
    });
  });

  describe('POST /money-requests/:id/pay — note and visibility', () => {
    it("copies the request's note onto the transfer and writes the post with the payer's visibility", async () => {
      const requester = await seedUser('requester');
      const payer = await seedUser('payer', 5_000_000n);
      const requestId = await createRequest(
        requester.userId,
        payer.userId,
        'For lunch yesterday',
      );
      const reference = `cliqpay-social-pay-${randomUUID()}`;

      await pay(payer.userId, requestId, {
        reference,
        visibility: 'public',
      }).expect(201);

      const transaction = await ctx.transactionRepo.findOneByOrFail({
        reference,
      });
      expect(transaction.metadata).toMatchObject({
        note: 'For lunch yesterday',
      });
      const post = await postRepo().findOneByOrFail({
        transactionId: transaction.id,
      });
      expect(post).toMatchObject({
        senderUserId: payer.userId,
        recipientUserId: requester.userId,
        note: 'For lunch yesterday',
        visibility: 'public',
      });
    });

    it('rejects a missing or invalid visibility with 400, leaving the request pending', async () => {
      const requester = await seedUser('requester');
      const payer = await seedUser('payer', 5_000_000n);
      const requestId = await createRequest(requester.userId, payer.userId);
      const reference = `cliqpay-social-pay-${randomUUID()}`;

      await pay(payer.userId, requestId, { reference }).expect(400);
      await pay(payer.userId, requestId, {
        reference,
        visibility: 'friends',
      }).expect(400);

      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: requestId })).status,
      ).toBe('pending');
    });
  });

  describe('idempotency fingerprint', () => {
    it('returns the original response for an identical replay without creating a second post', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const body = sendBody(recipient.userId, {
        note: 'rent',
        visibility: 'public',
      });

      const first = await send(sender.userId, body).expect(201);
      const second = await send(sender.userId, body).expect(201);

      expect(dataOf(second)).toEqual(dataOf(first));
      expect(
        await postRepo().countBy({
          transactionId: await transactionIdOf(body.reference),
        }),
      ).toBe(1);
    });

    it('replays the original response after the sender has changed the post visibility', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const body = sendBody(recipient.userId, { visibility: 'public' });
      const first = await send(sender.userId, body).expect(201);
      const transactionId = await transactionIdOf(body.reference);
      await request(ctx.app.getHttpServer())
        .patch(`/social/posts/${transactionId}/visibility`)
        .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
        .send({ visibility: 'private' })
        .expect(200);

      const second = await send(sender.userId, body).expect(201);

      expect(dataOf(second)).toEqual(dataOf(first));
      expect(await postRepo().countBy({ transactionId })).toBe(1);
    });

    it('rejects a replay whose visibility differs from the one originally sent, even when it matches the toggled value', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const body = sendBody(recipient.userId, { visibility: 'public' });
      await send(sender.userId, body).expect(201);
      const transactionId = await transactionIdOf(body.reference);
      await request(ctx.app.getHttpServer())
        .patch(`/social/posts/${transactionId}/visibility`)
        .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
        .send({ visibility: 'private' })
        .expect(200);

      await send(sender.userId, { ...body, visibility: 'private' }).expect(409);
    });

    it('stores no note anywhere for a whitespace-only note, and replays identically', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const body = sendBody(recipient.userId, {
        note: '   ',
        visibility: 'public',
      });

      const first = await send(sender.userId, body).expect(201);
      const second = await send(sender.userId, body).expect(201);

      expect(dataOf(second)).toEqual(dataOf(first));
      const transactionId = await transactionIdOf(body.reference);
      const post = await postRepo().findOneByOrFail({ transactionId });
      expect(post.note).toBeNull();
      const tx = await ctx.transactionRepo.findOneByOrFail({
        id: transactionId,
      });
      expect((tx.metadata as { note?: string } | null)?.note).toBeUndefined();
    });

    it.each([
      ['note', { note: 'different', visibility: 'public' }],
      ['visibility', { note: 'rent', visibility: 'private' }],
      ['dropping the note', { visibility: 'public' }],
    ])('rejects a replay with a changed %s as 409', async (_l, changed) => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const original = sendBody(recipient.userId, {
        note: 'rent',
        visibility: 'public',
      });
      await send(sender.userId, original).expect(201);

      await send(sender.userId, {
        ...original,
        note: undefined,
        ...changed,
      }).expect(409);

      expect(
        await postRepo().countBy({
          transactionId: await transactionIdOf(original.reference),
        }),
      ).toBe(1);
    });

    it('replays a paid money request, and rejects the replay with a changed visibility as 409', async () => {
      const requester = await seedUser('requester');
      const payer = await seedUser('payer', 5_000_000n);
      const requestId = await createRequest(
        requester.userId,
        payer.userId,
        'dinner',
      );
      const reference = `cliqpay-social-pay-${randomUUID()}`;
      await pay(payer.userId, requestId, {
        reference,
        visibility: 'public',
      }).expect(201);

      await pay(payer.userId, requestId, {
        reference,
        visibility: 'public',
      }).expect(201);
      await pay(payer.userId, requestId, {
        reference,
        visibility: 'private',
      }).expect(409);

      expect(
        await postRepo().countBy({
          transactionId: await transactionIdOf(reference),
        }),
      ).toBe(1);
    });
  });

  describe('atomicity with the transfer', () => {
    it('leaves no post when the transfer rolls back', async () => {
      const sender = await seedUser('sender', 10_000n);
      const recipient = await seedUser('recipient');
      const before = await postRepo().count();

      await send(
        sender.userId,
        sendBody(recipient.userId, { visibility: 'public' }),
      ).expect(422);

      expect(await postRepo().count()).toBe(before);
    });

    it('rolls the transfer back when the post insert fails', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const body = sendBody(recipient.userId, { visibility: 'public' });
      jest
        .spyOn(ctx.socialService, 'recordTransferPost')
        .mockRejectedValueOnce(new Error('post insert failed'));

      await send(sender.userId, body).expect(500);

      expect(
        await ctx.transactionRepo.findOneBy({ reference: body.reference }),
      ).toBeNull();
      expect(
        (await ctx.accountRepo.findOneByOrFail({ id: sender.walletId }))
          .balance,
      ).toBe(5_000_000n);
      expect(
        (await ctx.accountRepo.findOneByOrFail({ id: recipient.walletId }))
          .balance,
      ).toBe(0n);
    });

    it('rolls the money request payment back when the post insert fails', async () => {
      const requester = await seedUser('requester');
      const payer = await seedUser('payer', 5_000_000n);
      const requestId = await createRequest(requester.userId, payer.userId);
      const reference = `cliqpay-social-pay-${randomUUID()}`;
      jest
        .spyOn(ctx.socialService, 'recordTransferPost')
        .mockRejectedValueOnce(new Error('post insert failed'));

      await pay(payer.userId, requestId, {
        reference,
        visibility: 'public',
      }).expect(500);

      expect(await ctx.transactionRepo.findOneBy({ reference })).toBeNull();
      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: requestId })).status,
      ).toBe('pending');
    });
  });

  describe('note surfaces', () => {
    it('returns the note on P2P rows of GET /wallet/transactions for both parties, null when absent', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const withNote = sendBody(recipient.userId, {
        note: 'for the tickets',
        visibility: 'private',
      });
      const withoutNote = sendBody(recipient.userId, { visibility: 'private' });
      await send(sender.userId, withNote).expect(201);
      await send(sender.userId, withoutNote).expect(201);

      for (const userId of [sender.userId, recipient.userId]) {
        const res = await request(ctx.app.getHttpServer())
          .get('/wallet/transactions')
          .set('Authorization', `Bearer ${tokenFor(userId)}`)
          .expect(200);
        const items = dataOf<{ items: HistoryItem[] }>(res).items;
        const p2p = items.filter((i) => i.type === 'p2p_transfer');
        expect(p2p.find((i) => i.reference === withNote.reference)?.note).toBe(
          'for the tickets',
        );
        expect(
          p2p.find((i) => i.reference === withoutNote.reference)?.note,
        ).toBeNull();
      }
    });

    it('includes the note in the transfer_received notification when present', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const body = sendBody(recipient.userId, {
        note: 'happy birthday',
        visibility: 'private',
      });
      await send(sender.userId, body).expect(201);

      await waitFor(
        async () =>
          (await ctx.notificationRepo.countBy({
            userId: recipient.userId,
            type: 'transfer_received',
          })) > 0,
      );
      const [notification] = await ctx.notificationRepo.findBy({
        userId: recipient.userId,
        type: 'transfer_received',
      });
      expect(notification.data).toMatchObject({ note: 'happy birthday' });
    });

    it('omits the note from the notification when there is none', async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      await send(
        sender.userId,
        sendBody(recipient.userId, { visibility: 'private' }),
      ).expect(201);

      await waitFor(
        async () =>
          (await ctx.notificationRepo.countBy({
            userId: recipient.userId,
            type: 'transfer_received',
          })) > 0,
      );
      const [notification] = await ctx.notificationRepo.findBy({
        userId: recipient.userId,
        type: 'transfer_received',
      });
      expect(notification.data).not.toHaveProperty('note');
    });
  });

  describe('post endpoints', () => {
    async function seedPost(visibility: 'public' | 'private') {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const stranger = await seedUser('stranger');
      const body = sendBody(recipient.userId, { visibility });
      await send(sender.userId, body).expect(201);
      return {
        sender,
        recipient,
        stranger,
        transactionId: await transactionIdOf(body.reference),
      };
    }

    function setVisibility(
      userId: string,
      transactionId: string,
      visibility: unknown,
    ) {
      return request(ctx.app.getHttpServer())
        .patch(`/social/posts/${transactionId}/visibility`)
        .set('Authorization', `Bearer ${tokenFor(userId)}`)
        .send({ visibility });
    }

    function hide(
      method: 'put' | 'delete',
      userId: string,
      transactionId: string,
    ) {
      return request(ctx.app.getHttpServer())
        [method](`/social/posts/${transactionId}/hide`)
        .set('Authorization', `Bearer ${tokenFor(userId)}`);
    }

    it('lets the sender change visibility in either direction', async () => {
      const { sender, transactionId } = await seedPost('private');

      const toPublic = await setVisibility(
        sender.userId,
        transactionId,
        'public',
      ).expect(200);
      expect(dataOf(toPublic)).toMatchObject({ visibility: 'public' });
      expect(
        (await postRepo().findOneByOrFail({ transactionId })).visibility,
      ).toBe('public');

      await setVisibility(sender.userId, transactionId, 'private').expect(200);
      expect(
        (await postRepo().findOneByOrFail({ transactionId })).visibility,
      ).toBe('private');
    });

    it('rejects an invalid visibility with 400', async () => {
      const { sender, transactionId } = await seedPost('private');

      await setVisibility(sender.userId, transactionId, 'friends').expect(400);
      await setVisibility(sender.userId, transactionId, undefined).expect(400);
    });

    it('lets the recipient hide and unhide, independently of the sender visibility', async () => {
      const { sender, recipient, transactionId } = await seedPost('public');

      const hidden = await hide('put', recipient.userId, transactionId).expect(
        200,
      );
      expect(dataOf(hidden)).toMatchObject({
        visibility: 'public',
        hiddenByRecipient: true,
      });
      await hide('put', recipient.userId, transactionId).expect(200);

      await setVisibility(sender.userId, transactionId, 'private').expect(200);
      expect(
        (await postRepo().findOneByOrFail({ transactionId })).hiddenByRecipient,
      ).toBe(true);

      await hide('delete', recipient.userId, transactionId).expect(200);
      expect(await postRepo().findOneByOrFail({ transactionId })).toMatchObject(
        { hiddenByRecipient: false, visibility: 'private' },
      );
    });

    it('answers 404 to the wrong participant and to a non-participant, changing nothing', async () => {
      const { sender, recipient, stranger, transactionId } =
        await seedPost('public');

      for (const userId of [recipient.userId, stranger.userId]) {
        const res = await setVisibility(
          userId,
          transactionId,
          'private',
        ).expect(404);
        expect(errorOf(res).code).toBe('POST_NOT_FOUND');
      }
      for (const method of ['put', 'delete'] as const) {
        for (const userId of [sender.userId, stranger.userId]) {
          await hide(method, userId, transactionId).expect(404);
        }
      }

      expect(await postRepo().findOneByOrFail({ transactionId })).toMatchObject(
        { visibility: 'public', hiddenByRecipient: false },
      );
    });

    it('answers 404 for an unknown transaction and 400 for a malformed id', async () => {
      const { sender } = await seedPost('public');

      await setVisibility(sender.userId, randomUUID(), 'public').expect(404);
      await setVisibility(sender.userId, 'not-a-uuid', 'public').expect(400);
    });

    it('requires authentication', async () => {
      await request(ctx.app.getHttpServer())
        .put(`/social/posts/${randomUUID()}/hide`)
        .expect(401);
    });

    describe('using only ids the API returns', () => {
      function getPost(userId: string, transactionId: string) {
        return request(ctx.app.getHttpServer())
          .get(`/social/posts/${transactionId}`)
          .set('Authorization', `Bearer ${tokenFor(userId)}`);
      }

      async function feedIds(userId: string): Promise<string[]> {
        const res = await request(ctx.app.getHttpServer())
          .get('/social/feed')
          .set('Authorization', `Bearer ${tokenFor(userId)}`)
          .expect(200);
        return dataOf<{ items: { transactionId: string }[] }>(res).items.map(
          (item) => item.transactionId,
        );
      }

      async function historyTransactionId(
        userId: string,
        reference: string,
      ): Promise<string | null | undefined> {
        const res = await request(ctx.app.getHttpServer())
          .get('/wallet/transactions')
          .set('Authorization', `Bearer ${tokenFor(userId)}`)
          .expect(200);
        return dataOf<{ items: HistoryItem[] }>(res).items.find(
          (item) => item.reference === reference,
        )?.transactionId;
      }

      it('makes a post sent private public with the transactionId from the transfer response', async () => {
        const sender = await seedUser('sender', 5_000_000n);
        const recipient = await seedUser('recipient');
        const follower = await seedUser('follower');
        await request(ctx.app.getHttpServer())
          .put(`/social/follows/${sender.userId}`)
          .set('Authorization', `Bearer ${tokenFor(follower.userId)}`)
          .expect(200);
        const body = sendBody(recipient.userId, { visibility: 'private' });

        const sent = await send(sender.userId, body).expect(201);
        const { transactionId } = dataOf<{ transactionId: string }>(sent);
        const replay = await send(sender.userId, body).expect(201);
        expect(dataOf(replay)).toMatchObject({ transactionId });

        expect(
          dataOf(await getPost(sender.userId, transactionId).expect(200)),
        ).toMatchObject({ visibility: 'private' });
        expect(await feedIds(follower.userId)).not.toContain(transactionId);

        await setVisibility(sender.userId, transactionId, 'public').expect(200);

        expect(await feedIds(follower.userId)).toContain(transactionId);
        expect(
          dataOf(await getPost(recipient.userId, transactionId).expect(200)),
        ).toMatchObject({ visibility: 'public', hiddenByRecipient: false });
      });

      it('finds a post toggled private again through /wallet/transactions, for both participants', async () => {
        const sender = await seedUser('sender', 5_000_000n);
        const recipient = await seedUser('recipient');
        const body = sendBody(recipient.userId, { visibility: 'public' });
        const sent = await send(sender.userId, body).expect(201);
        await setVisibility(
          sender.userId,
          dataOf<{ transactionId: string }>(sent).transactionId,
          'private',
        ).expect(200);

        const senderId = await historyTransactionId(
          sender.userId,
          body.reference,
        );
        const recipientId = await historyTransactionId(
          recipient.userId,
          body.reference,
        );
        expect(senderId).toEqual(expect.any(String));
        expect(recipientId).toBe(senderId);

        expect(
          dataOf(await getPost(sender.userId, senderId!).expect(200)),
        ).toMatchObject({ visibility: 'private' });
        await setVisibility(sender.userId, senderId!, 'public').expect(200);
        await hide('put', recipient.userId, recipientId!).expect(200);
        expect(
          dataOf(await getPost(recipient.userId, recipientId!).expect(200)),
        ).toMatchObject({ visibility: 'public', hiddenByRecipient: true });
      });

      it("makes a paid request's private post public with the transactionId from the pay response", async () => {
        const payer = await seedUser('payer', 5_000_000n);
        const requester = await seedUser('requester');
        const requestId = await createRequest(requester.userId, payer.userId);
        const payBody = {
          reference: `cliqpay-social-${randomUUID()}`,
          visibility: 'private',
        };

        const paid = await pay(payer.userId, requestId, payBody).expect(201);
        const { transactionId } = dataOf<{ transactionId: string | null }>(
          paid,
        );
        expect(transactionId).toEqual(expect.any(String));
        const replay = await pay(payer.userId, requestId, payBody).expect(201);
        expect(dataOf(replay)).toMatchObject({ transactionId });

        await setVisibility(payer.userId, transactionId!, 'public').expect(200);

        expect(
          dataOf(await getPost(requester.userId, transactionId!).expect(200)),
        ).toMatchObject({ visibility: 'public' });
      });
    });
  });
});
