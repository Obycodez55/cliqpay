import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  seedTransferUser,
} from './support/transfers-test-context';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

interface MoneyRequestBody {
  id: string;
  counterparty: { userId: string };
  amount: { amount: string; currency: string };
  note: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
}

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

describe('POST /money-requests/:id/cancel and /decline', () => {
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

  function nextIdentity(prefix: string) {
    idSeq += 1;
    const n = idSeq;
    return {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348044${String(300_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
    };
  }

  async function seedUser(prefix: string) {
    return seedTransferUser(ctx, nextIdentity(prefix));
  }

  async function create(
    token: string,
    body: Record<string, unknown>,
    expectStatus: number,
  ): Promise<MoneyRequestBody> {
    const res = await request(ctx.app.getHttpServer())
      .post('/money-requests')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(expectStatus);
    return res.body as MoneyRequestBody;
  }

  async function cancel(
    token: string,
    id: string,
    expectStatus: number,
  ): Promise<MoneyRequestBody> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/money-requests/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send()
      .expect(expectStatus);
    return res.body as MoneyRequestBody;
  }

  async function decline(
    token: string,
    id: string,
    expectStatus: number,
  ): Promise<MoneyRequestBody> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/money-requests/${id}/decline`)
      .set('Authorization', `Bearer ${token}`)
      .send()
      .expect(expectStatus);
    return res.body as MoneyRequestBody;
  }

  describe('cancel', () => {
    it('lets the requester cancel a pending request', async () => {
      const requester = await seedUser('cancelreq');
      const payer = await seedUser('cancelpay');
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 20_000 },
        201,
      );

      const cancelled = await cancel(
        tokenFor(requester.userId),
        created.id,
        201,
      );
      expect(cancelled.status).toBe('cancelled');

      const row = await ctx.moneyRequestRepo.findOneByOrFail({
        id: created.id,
      });
      expect(row.status).toBe('cancelled');
    });

    it('rejects cancel from anyone other than the requester', async () => {
      const requester = await seedUser('cancelreq2');
      const payer = await seedUser('cancelpay2');
      const stranger = await seedUser('cancelstranger');
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 20_000 },
        201,
      );

      await cancel(tokenFor(payer.userId), created.id, 404);
      await cancel(tokenFor(stranger.userId), created.id, 404);
    });

    it('rejects cancel once the request has expired, even though status is still pending in the row', async () => {
      const requester = await seedUser('cancelexpreq');
      const payer = await seedUser('cancelexppay');
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 20_000 },
        201,
      );
      await ctx.moneyRequestRepo.update(
        { id: created.id },
        { expiresAt: new Date(Date.now() - 60_000) },
      );

      await cancel(tokenFor(requester.userId), created.id, 404);

      const row = await ctx.moneyRequestRepo.findOneByOrFail({
        id: created.id,
      });
      expect(row.status).toBe('pending');
    });

    it('sends no notification on cancel', async () => {
      const requester = await seedUser('notifycancelreq');
      const payer = await seedUser('notifycancelpay');
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 80_000 },
        201,
      );
      // The create step itself notifies the payer (money_request_created) —
      // wait for that to land first so it isn't mistaken for a cancel
      // notification below.
      await waitFor(async () => {
        const payerInApp = await ctx.notificationRepo.findBy({
          userId: payer.userId,
          type: 'money_request_created',
        });
        return payerInApp.length > 0;
      });
      const countBefore = await ctx.notificationRepo.count();

      await cancel(tokenFor(requester.userId), created.id, 201);

      // Give any (incorrect) async publish a moment to land before asserting
      // its absence.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const countAfter = await ctx.notificationRepo.count();
      expect(countAfter).toBe(countBefore);
    });
  });

  describe('decline', () => {
    it('lets the payer decline a pending request', async () => {
      const requester = await seedUser('declinereq');
      const payer = await seedUser('declinepay');
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 30_000 },
        201,
      );

      const declined = await decline(tokenFor(payer.userId), created.id, 201);
      expect(declined.status).toBe('declined');

      const row = await ctx.moneyRequestRepo.findOneByOrFail({
        id: created.id,
      });
      expect(row.status).toBe('declined');
    });

    it('rejects decline from anyone other than the payer', async () => {
      const requester = await seedUser('declinereq2');
      const payer = await seedUser('declinepay2');
      const stranger = await seedUser('declinestranger');
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 30_000 },
        201,
      );

      await decline(tokenFor(requester.userId), created.id, 404);
      await decline(tokenFor(stranger.userId), created.id, 404);
    });

    it('rejects decline once the request has expired, even though status is still pending in the row', async () => {
      const requester = await seedUser('declineexpreq');
      const payer = await seedUser('declineexppay');
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 30_000 },
        201,
      );
      await ctx.moneyRequestRepo.update(
        { id: created.id },
        { expiresAt: new Date(Date.now() - 60_000) },
      );

      await decline(tokenFor(payer.userId), created.id, 404);

      const row = await ctx.moneyRequestRepo.findOneByOrFail({
        id: created.id,
      });
      expect(row.status).toBe('pending');
    });

    it('notifies the requester on decline, across email, push, and in-app', async () => {
      const requester = await seedUser('notifydeclinereq');
      const payer = await seedUser('notifydeclinepay');
      await ctx.notificationService.registerPushToken(
        requester.userId,
        'android',
        `push-token-requester-${requester.userId}`,
      );
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 70_000 },
        201,
      );
      const emailCountBefore = ctx.emailAdapter.sent.length;

      await decline(tokenFor(payer.userId), created.id, 201);

      await waitFor(async () => {
        const requesterInApp = await ctx.notificationRepo.findBy({
          userId: requester.userId,
          type: 'money_request_declined',
        });
        return requesterInApp.length > 0;
      });

      const requesterInApp = await ctx.notificationRepo.findBy({
        userId: requester.userId,
        type: 'money_request_declined',
      });
      expect(requesterInApp[0].dedupeKey).toBe(created.id);

      await waitFor(() => ctx.emailAdapter.sent.length >= emailCountBefore + 1);
      const newEmails = ctx.emailAdapter.sent.slice(emailCountBefore);
      expect(newEmails.some((m) => m.subject.includes('declined'))).toBe(true);

      expect(
        ctx.pushAdapter.sent.some(
          (m) => m.token === `push-token-requester-${requester.userId}`,
        ),
      ).toBe(true);
    });
  });
});
