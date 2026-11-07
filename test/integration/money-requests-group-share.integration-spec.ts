import { randomUUID } from 'crypto';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  SplitBody,
  SplitUser,
  createBillSplitHelpers,
  createBillSplitTestContext,
} from './support/billsplit-test-context';
import { dataOf, errorOf } from './support/api-response';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import {
  MONEY_REQUEST_CREATED_EVENT,
  MoneyRequestCreatedEventPayload,
} from '../../src/shared/events/domain-events';

jest.setTimeout(180_000);

interface PaidRequestBody {
  id: string;
  status: string;
  transactionId: string | null;
}

describe('money request kinds — paying direct and group-share requests', () => {
  let ctx: TransfersTestContext;
  const h = createBillSplitHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createBillSplitTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedShare() {
    const initiator = await h.seedUser('initiator');
    const payer = await h.seedUser('payer', { balanceMinor: 50_000_000n });
    const split = dataOf<SplitBody>(
      await h
        .createSplit(initiator.userId, {
          description: 'Concert',
          total: 40_000,
          participants: [{ userId: payer.userId }],
        })
        .expect(201),
    );
    return {
      initiator,
      payer,
      requestId: split.participants[0].moneyRequestId,
    };
  }

  async function seedDirect(note?: string) {
    const requester = await h.seedUser('requester');
    const payer = await h.seedUser('payer', { balanceMinor: 50_000_000n });
    const res = await h
      .http()
      .post('/money-requests')
      .set('Authorization', `Bearer ${h.tokenFor(requester.userId)}`)
      .send({ payerUserId: payer.userId, amount: 20_000, note })
      .expect(201);
    return { requester, payer, requestId: dataOf<{ id: string }>(res).id };
  }

  function getPost(viewer: SplitUser, postId: string) {
    return h
      .http()
      .get(`/social/posts/${postId}`)
      .set('Authorization', `Bearer ${h.tokenFor(viewer.userId)}`);
  }

  describe('kind', () => {
    it('creates a direct request as direct and defaults existing rows to direct', async () => {
      const { requestId } = await seedDirect();
      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: requestId })).kind,
      ).toBe('direct');

      const [row] = await ctx.dataSource.query<{ kind: string }[]>(
        `INSERT INTO money_requests (requester_user_id, payer_user_id, amount, currency, status, expires_at)
         VALUES ($1, $2, 10000, 'NGN', 'pending', now() + interval '1 day') RETURNING kind`,
        [randomUUID(), randomUUID()],
      );
      expect(row.kind).toBe('direct');
    });

    it('rejects a kind outside direct and group_share', async () => {
      await expect(
        ctx.dataSource.query(
          `INSERT INTO money_requests (requester_user_id, payer_user_id, amount, currency, kind, status, expires_at)
           VALUES ($1, $2, 10000, 'NGN', 'other', 'pending', now() + interval '1 day')`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toThrow(/CHK_money_requests_kind/);
    });

    it('exposes the kind on the create response, the lists and the created event', async () => {
      const publish = jest.spyOn(ctx.app.get(EventBusService), 'publish');
      try {
        const requester = await h.seedUser('requester');
        const payer = await h.seedUser('payer', { balanceMinor: 50_000_000n });
        const created = await h
          .http()
          .post('/money-requests')
          .set('Authorization', `Bearer ${h.tokenFor(requester.userId)}`)
          .send({ payerUserId: payer.userId, amount: 20_000 })
          .expect(201);
        expect(dataOf<{ kind: string }>(created).kind).toBe('direct');

        const split = dataOf<SplitBody>(
          await h
            .createSplit(requester.userId, {
              total: 40_000,
              participants: [{ userId: payer.userId }],
            })
            .expect(201),
        );
        const shareId = split.participants[0].moneyRequestId;

        const incoming = dataOf<{ items: { id: string; kind: string }[] }>(
          await h
            .http()
            .get('/money-requests/incoming')
            .set('Authorization', `Bearer ${h.tokenFor(payer.userId)}`)
            .expect(200),
        ).items;
        expect(
          incoming.find((r) => r.id === dataOf<{ id: string }>(created).id)
            ?.kind,
        ).toBe('direct');
        expect(incoming.find((r) => r.id === shareId)?.kind).toBe(
          'group_share',
        );

        const kindOfEvent = (moneyRequestId: string) =>
          publish.mock.calls
            .map(([event]) => event)
            .filter((event) => event.name === MONEY_REQUEST_CREATED_EVENT)
            .map((event) => event.payload as MoneyRequestCreatedEventPayload)
            .find((payload) => payload.moneyRequestId === moneyRequestId)?.kind;
        expect(kindOfEvent(dataOf<{ id: string }>(created).id)).toBe('direct');
        expect(kindOfEvent(shareId)).toBe('group_share');
      } finally {
        publish.mockRestore();
      }
    });

    it('creates split requests as group_share', async () => {
      const { requestId } = await seedShare();
      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: requestId })).kind,
      ).toBe('group_share');
    });
  });

  describe('paying a group-share request', () => {
    it('moves the money and records no post', async () => {
      const { initiator, payer, requestId } = await seedShare();

      const paid = dataOf<PaidRequestBody>(
        await h.payRequest(payer.userId, requestId).expect(201),
      );

      expect(paid.status).toBe('paid');
      expect(paid.transactionId).not.toBeNull();
      const transaction = await ctx.transactionRepo.findOneByOrFail({
        id: paid.transactionId!,
      });
      expect(transaction.type).toBe('p2p_transfer');
      expect(transaction.amount).toBe(20_000n);

      const [{ count }] = await ctx.dataSource.query<{ count: string }[]>(
        `SELECT count(*) FROM posts WHERE id = $1`,
        [paid.transactionId],
      );
      expect(Number(count)).toBe(0);
      await getPost(payer, paid.transactionId!).expect(404);
      await getPost(initiator, paid.transactionId!).expect(404);
    });

    it('rejects a visibility with a 400 and leaves the request pending', async () => {
      const { payer, requestId } = await seedShare();

      for (const visibility of ['public', 'private']) {
        const res = await h
          .payRequest(payer.userId, requestId, { visibility })
          .expect(400);
        expect(errorOf(res).code).toBe('GROUP_SHARE_VISIBILITY_NOT_ALLOWED');
      }
      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: requestId })).status,
      ).toBe('pending');
    });

    it('returns the original payment on a replay of the same reference, with no second transfer', async () => {
      const { payer, requestId } = await seedShare();
      const reference = `replay-${randomUUID()}`;

      const first = dataOf<PaidRequestBody>(
        await h.payRequest(payer.userId, requestId, { reference }).expect(201),
      );
      const replay = dataOf<PaidRequestBody>(
        await h.payRequest(payer.userId, requestId, { reference }).expect(201),
      );

      expect(replay.transactionId).toBe(first.transactionId);
      expect(await ctx.transactionRepo.countBy({ reference })).toBe(1);
    });

    it('rejects a replayed reference whose recorded note differs', async () => {
      const { payer, requestId } = await seedShare();
      const reference = `note-${randomUUID()}`;
      await h.payRequest(payer.userId, requestId, { reference }).expect(201);

      await ctx.moneyRequestRepo.update(
        { id: requestId },
        { note: 'A different note' },
      );

      await h.payRequest(payer.userId, requestId, { reference }).expect(409);
    });

    it('does not treat the reference of an unrelated transfer as a replay of the share payment', async () => {
      const { initiator, payer, requestId } = await seedShare();
      const reference = `plain-${randomUUID()}`;
      await h
        .http()
        .post('/transfers')
        .set('Authorization', `Bearer ${h.tokenFor(payer.userId)}`)
        .send({
          reference,
          recipientUserId: initiator.userId,
          amount: 20_000,
          pin: '1234',
          visibility: 'private',
          note: 'Concert',
        })
        .expect(201);

      await h.payRequest(payer.userId, requestId, { reference }).expect(409);
    });
  });

  describe('paying a direct request', () => {
    it('still requires a visibility', async () => {
      const { payer, requestId } = await seedDirect();

      const res = await h.payRequest(payer.userId, requestId).expect(400);

      expect(errorOf(res).code).toBe('PAYMENT_VISIBILITY_REQUIRED');
      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: requestId })).status,
      ).toBe('pending');
    });

    it('rejects an invalid visibility', async () => {
      const { payer, requestId } = await seedDirect();
      await h
        .payRequest(payer.userId, requestId, { visibility: 'friends' })
        .expect(400);
    });

    it('records a post with origin money_request, carried on the post view', async () => {
      const { requester, payer, requestId } = await seedDirect('Lunch');

      const paid = dataOf<PaidRequestBody>(
        await h
          .payRequest(payer.userId, requestId, { visibility: 'public' })
          .expect(201),
      );

      const [row] = await ctx.dataSource.query<
        { origin: string; kind: string }[]
      >(`SELECT origin, kind FROM posts WHERE id = $1`, [paid.transactionId]);
      expect(row).toEqual({ origin: 'money_request', kind: 'transfer' });
      for (const viewer of [payer, requester]) {
        const view = dataOf<{ origin: string }>(
          await getPost(viewer, paid.transactionId!).expect(200),
        );
        expect(view.origin).toBe('money_request');
      }
    });

    it('carries origin on feed items, and null for a plain send', async () => {
      const { requester, payer, requestId } = await seedDirect();
      const follower = await h.seedUser('follower');
      await h
        .http()
        .put(`/social/follows/${payer.userId}`)
        .set('Authorization', `Bearer ${h.tokenFor(follower.userId)}`)
        .expect(200);
      const viaRequest = dataOf<PaidRequestBody>(
        await h
          .payRequest(payer.userId, requestId, { visibility: 'public' })
          .expect(201),
      );
      const plain = dataOf<{ transactionId: string }>(
        await h
          .http()
          .post('/transfers')
          .set('Authorization', `Bearer ${h.tokenFor(payer.userId)}`)
          .send({
            reference: `plain-${randomUUID()}`,
            recipientUserId: requester.userId,
            amount: 20_000,
            pin: '1234',
            visibility: 'public',
          })
          .expect(201),
      );

      const feed = dataOf<{
        items: { transactionId: string; origin: string | null }[];
      }>(
        await h
          .http()
          .get('/social/feed')
          .set('Authorization', `Bearer ${h.tokenFor(follower.userId)}`)
          .expect(200),
      );
      const originOf = (id: string) =>
        feed.items.find((i) => i.transactionId === id)?.origin;
      expect(originOf(viaRequest.transactionId!)).toBe('money_request');
      expect(originOf(plain.transactionId)).toBeNull();
    });

    it('still compares visibility on a replay of a direct payment', async () => {
      const { payer, requestId } = await seedDirect();
      const reference = `direct-replay-${randomUUID()}`;
      await h
        .payRequest(payer.userId, requestId, {
          reference,
          visibility: 'private',
        })
        .expect(201);

      await h
        .payRequest(payer.userId, requestId, {
          reference,
          visibility: 'public',
        })
        .expect(409);
      await h
        .payRequest(payer.userId, requestId, {
          reference,
          visibility: 'private',
        })
        .expect(201);
    });
  });
});
