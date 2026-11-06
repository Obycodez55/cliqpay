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
import { EventBusService } from '../../src/shared/events/event-bus.service';
import {
  MONEY_REQUEST_CREATED_EVENT,
  MoneyRequestCreatedEventPayload,
} from '../../src/shared/events/domain-events';

jest.setTimeout(180_000);

interface MoneyRequestBody {
  id: string;
  status: string;
}

describe('Social blocks on the money path', () => {
  let ctx: TransfersTestContext;
  const {
    tokenFor,
    http,
    seedUser,
    seedFunded,
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

  function sendMoney(senderId: string, recipientId: string) {
    return http()
      .post('/transfers')
      .set('Authorization', `Bearer ${tokenFor(senderId)}`)
      .send({
        recipientUserId: recipientId,
        amount: 10_000,
        reference: `cliqpay-block-xfer-${randomUUID()}`,
        pin: '1234',
        visibility: 'private',
      });
  }

  function createRequest(requesterId: string, payerId: string) {
    return http()
      .post('/money-requests')
      .set('Authorization', `Bearer ${tokenFor(requesterId)}`)
      .send({ payerUserId: payerId, amount: 10_000 });
  }

  function payRequest(payerId: string, id: string) {
    return http()
      .post(`/money-requests/${id}/pay`)
      .set('Authorization', `Bearer ${tokenFor(payerId)}`)
      .send({
        reference: `cliqpay-block-pay-${randomUUID()}`,
        pin: '1234',
        visibility: 'private',
      });
  }

  async function incomingIds(payerId: string): Promise<string[]> {
    const res = await http()
      .get('/money-requests/incoming')
      .set('Authorization', `Bearer ${tokenFor(payerId)}`)
      .expect(200);
    return dataOf<{ items: { id: string }[] }>(res).items.map(
      (item) => item.id,
    );
  }

  describe('transfers', () => {
    it.each(directions)(
      'rejects sendMoney either way when $name',
      async ({ blockerIndex }) => {
        const users: [SeededUser, SeededUser] = [
          await seedFunded('xa'),
          await seedFunded('xb'),
        ];
        await blockBetween(users, blockerIndex);

        for (const [sender, recipient] of [users, [...users].reverse()]) {
          const res = await sendMoney(sender.userId, recipient.userId).expect(
            422,
          );
          expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
          expectNoBlockedWording(res);
        }
      },
    );

    it('posts nothing when sendMoney is rejected by a block', async () => {
      const sender = await seedFunded('xna');
      const recipient = await seedFunded('xnb');
      await block(recipient.userId, sender.userId).expect(200);
      const before = await ctx.ledgerEntryRepo.count();

      await sendMoney(sender.userId, recipient.userId).expect(422);

      expect(await ctx.ledgerEntryRepo.count()).toBe(before);
    });

    it('sends again once unblocked', async () => {
      const sender = await seedFunded('xua');
      const recipient = await seedFunded('xub');
      await block(recipient.userId, sender.userId).expect(200);
      await unblock(recipient.userId, sender.userId).expect(200);

      await sendMoney(sender.userId, recipient.userId).expect(201);
    });

    it.each(directions)(
      'rejects paying a money request when $name after it was sent',
      async ({ blockerIndex }) => {
        const requester = await seedFunded('pra');
        const payer = await seedFunded('prb');
        const created = dataOf<MoneyRequestBody>(
          await createRequest(requester.userId, payer.userId).expect(201),
        );
        await blockBetween([requester, payer], blockerIndex);

        const res = await payRequest(payer.userId, created.id).expect(422);

        expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
        expectNoBlockedWording(res);
        expect(
          (await ctx.moneyRequestRepo.findOneByOrFail({ id: created.id }))
            .status,
        ).toBe('pending');
      },
    );
  });

  describe('money requests', () => {
    it.each(directions)(
      'rejects creating a request either way when $name',
      async ({ blockerIndex }) => {
        const users: [SeededUser, SeededUser] = [
          await seedUser('mra', 'tier3'),
          await seedUser('mrb', 'tier3'),
        ];
        await blockBetween(users, blockerIndex);

        for (const [requester, payer] of [users, [...users].reverse()]) {
          const res = await createRequest(
            requester.userId,
            payer.userId,
          ).expect(422);
          expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
          expectNoBlockedWording(res);
        }
        expect(
          await ctx.moneyRequestRepo.countBy([
            { requesterUserId: users[0].userId },
            { requesterUserId: users[1].userId },
          ]),
        ).toBe(0);
      },
    );

    it('hides pending requests from users the payer blocked, without changing them, until unblocked', async () => {
      const payer = await seedUser('ipay', 'tier3');
      const requester = await seedUser('ireq', 'tier3');
      const other = await seedUser('ioth', 'tier3');
      const pending = dataOf<MoneyRequestBody>(
        await createRequest(requester.userId, payer.userId).expect(201),
      );
      const willExpire = dataOf<MoneyRequestBody>(
        await createRequest(requester.userId, payer.userId).expect(201),
      );
      const declined = dataOf<MoneyRequestBody>(
        await createRequest(requester.userId, payer.userId).expect(201),
      );
      await http()
        .post(`/money-requests/${declined.id}/decline`)
        .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
        .expect(201);
      const fromOther = dataOf<MoneyRequestBody>(
        await createRequest(other.userId, payer.userId).expect(201),
      );

      await block(payer.userId, requester.userId).expect(200);

      const whileBlocked = await incomingIds(payer.userId);
      expect(whileBlocked).toEqual(
        expect.arrayContaining([declined.id, fromOther.id]),
      );
      expect(whileBlocked).not.toContain(pending.id);
      expect(whileBlocked).not.toContain(willExpire.id);
      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: pending.id })).status,
      ).toBe('pending');

      await ctx.moneyRequestRepo.update(
        { id: willExpire.id },
        { expiresAt: new Date(Date.now() - 60_000) },
      );
      await unblock(payer.userId, requester.userId).expect(200);

      const afterRes = await http()
        .get('/money-requests/incoming')
        .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
        .expect(200);
      const statuses = new Map(
        dataOf<{ items: MoneyRequestBody[] }>(afterRes).items.map((item) => [
          item.id,
          item.status,
        ]),
      );
      expect(statuses.get(pending.id)).toBe('pending');
      expect(statuses.get(willExpire.id)).toBe('expired');
    });

    it('rejects a request the same way as a transfer, so the code reveals nothing more', async () => {
      const requester = await seedFunded('mca');
      const payer = await seedFunded('mcb');
      await block(payer.userId, requester.userId).expect(200);

      const requested = await createRequest(
        requester.userId,
        payer.userId,
      ).expect(422);
      const sent = await sendMoney(requester.userId, payer.userId).expect(422);

      expect(errorOf(requested)).toEqual(errorOf(sent));
    });

    it('lists incoming requests for a payer with more blocks than Postgres allows bind parameters', async () => {
      const payer = await seedUser('bigpay', 'tier3');
      const followed = await seedUser('bigfol', 'tier3');
      const stranger = await seedUser('bigstr', 'tier3');
      const fromFollowed = dataOf<MoneyRequestBody>(
        await createRequest(followed.userId, payer.userId).expect(201),
      );
      const fromStranger = dataOf<MoneyRequestBody>(
        await createRequest(stranger.userId, payer.userId).expect(201),
      );
      await follow(payer.userId, followed.userId).expect(200);
      await ctx.dataSource.query(
        `INSERT INTO blocks (blocker_user_id, blocked_user_id)
         SELECT $1, gen_random_uuid() FROM generate_series(1, 70000)`,
        [payer.userId],
      );

      expect(await incomingIds(payer.userId)).toEqual(
        expect.arrayContaining([fromFollowed.id, fromStranger.id]),
      );
      for (const [bucket, expected] of [
        ['following', fromFollowed.id],
        ['others', fromStranger.id],
      ]) {
        const res = await http()
          .get('/money-requests/incoming')
          .query({ bucket })
          .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
          .expect(200);
        expect(
          dataOf<{ items: { id: string }[] }>(res).items.map((item) => item.id),
        ).toEqual([expected]);
      }
    });

    it('keeps showing requests to the payer when it is the requester who blocked', async () => {
      const payer = await seedUser('rpay', 'tier3');
      const requester = await seedUser('rreq', 'tier3');
      const created = dataOf<MoneyRequestBody>(
        await createRequest(requester.userId, payer.userId).expect(201),
      );

      await block(requester.userId, payer.userId).expect(200);

      expect(await incomingIds(payer.userId)).toContain(created.id);
    });
  });

  describe('a block committed while money is waiting on the pair lock', () => {
    async function whileBlockLands<T>(
      blocker: SeededUser,
      blocked: SeededUser,
      act: () => Promise<T>,
    ): Promise<T> {
      const [low, high] = [blocker.userId, blocked.userId].sort();
      const runner = ctx.dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `social-pair:${low}:${high}`,
        ]);
        await runner.query(
          'INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)',
          [blocker.userId, blocked.userId],
        );
        const pending = act();
        await waitFor(async () => {
          const waiting: unknown[] = await ctx.dataSource.query(
            `SELECT 1 FROM pg_locks
             WHERE locktype = 'advisory' AND NOT granted
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          );
          return waiting.length > 0;
        });
        await runner.commitTransaction();
        return await pending;
      } finally {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction();
        }
        await runner.release();
      }
    }

    it('stops the transfer', async () => {
      const sender = await seedFunded('lxa');
      const recipient = await seedFunded('lxb');
      const before = await ctx.ledgerEntryRepo.count();

      const res = await whileBlockLands(recipient, sender, () =>
        sendMoney(sender.userId, recipient.userId).then((r) => r),
      );

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
      expect(await ctx.ledgerEntryRepo.count()).toBe(before);
    });

    it('stops the money request', async () => {
      const requester = await seedUser('lra', 'tier3');
      const payer = await seedUser('lrb', 'tier3');

      const res = await whileBlockLands(payer, requester, () =>
        createRequest(requester.userId, payer.userId).then((r) => r),
      );

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
      expect(
        await ctx.moneyRequestRepo.countBy({
          requesterUserId: requester.userId,
        }),
      ).toBe(0);
    });
  });

  describe('money_request_created notification', () => {
    async function publishCreated(
      requester: SeededUser,
      payer: SeededUser,
    ): Promise<void> {
      const payerUser = await ctx.usersService.findById(payer.userId);
      await ctx.app
        .get(EventBusService)
        .publish<string, MoneyRequestCreatedEventPayload>({
          name: MONEY_REQUEST_CREATED_EVENT,
          payload: {
            userId: payer.userId,
            email: payerUser.email,
            requesterUserId: requester.userId,
            counterpartyUsername: 'someone',
            amount: '100.00',
            currency: 'NGN',
            note: null,
            moneyRequestId: randomUUID(),
            fromFollowed: true,
          },
          occurredAt: new Date(),
        });
    }

    it.each(directions)(
      'is skipped at dispatch time when $name',
      async ({ blockerIndex }) => {
        const requester = await seedUser('mna');
        const payer = await seedUser('mnb');
        const token = `push-mr-block-${payer.userId}`;
        await ctx.notificationService.registerPushToken(
          payer.userId,
          'android',
          token,
        );
        const emailsBefore = ctx.emailAdapter.sent.length;
        await blockBetween([requester, payer], blockerIndex);

        await publishCreated(requester, payer);
        await waitForQueuesDrained();

        expect(
          await ctx.notificationRepo.countBy({
            userId: payer.userId,
            type: 'money_request_created',
          }),
        ).toBe(0);
        expect(
          ctx.pushAdapter.sent.filter((message) => message.token === token),
        ).toHaveLength(0);
        expect(ctx.emailAdapter.sent.length).toBe(emailsBefore);
      },
    );

    it('is still delivered when there is no block', async () => {
      const requester = await seedUser('mda');
      const payer = await seedUser('mdb');

      await publishCreated(requester, payer);
      await waitForQueuesDrained();

      expect(
        await ctx.notificationRepo.countBy({
          userId: payer.userId,
          type: 'money_request_created',
        }),
      ).toBe(1);
    });
  });

  describe('recipient lookup', () => {
    it('is unchanged by a block in either direction', async () => {
      const blocker = await seedUser('lka');
      const blocked = await seedUser('lkb');
      const [blockerUser, blockedUser] = await Promise.all([
        ctx.usersService.findById(blocker.userId),
        ctx.usersService.findById(blocked.userId),
      ]);
      await block(blocker.userId, blocked.userId).expect(200);

      for (const target of [blockerUser, blockedUser]) {
        const found = await ctx.usersService.lookupRecipient(target.username);
        expect(found?.userId).toBe(target.id);
      }
    });
  });
});
