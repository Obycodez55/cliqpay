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

interface MoneyRequestListBody {
  items: MoneyRequestBody[];
  nextCursor: string | null;
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

describe('Money requests', () => {
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

  async function listIncoming(token: string): Promise<MoneyRequestListBody> {
    const res = await request(ctx.app.getHttpServer())
      .get('/money-requests/incoming')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as MoneyRequestListBody;
  }

  async function listOutgoing(token: string): Promise<MoneyRequestListBody> {
    const res = await request(ctx.app.getHttpServer())
      .get('/money-requests/outgoing')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as MoneyRequestListBody;
  }

  it('rejects an unauthenticated create', async () => {
    await request(ctx.app.getHttpServer())
      .post('/money-requests')
      .send({})
      .expect(401);
  });

  it('creates a request against a resolved payer, with a note', async () => {
    const requester = await seedUser('requester');
    const payer = await seedUser('payer');

    const created = await create(
      tokenFor(requester.userId),
      {
        payerUserId: payer.userId,
        amount: 500_000,
        note: 'For lunch yesterday',
      },
      201,
    );

    expect(created).toMatchObject({
      counterparty: { userId: payer.userId },
      amount: { amount: '500000', currency: 'NGN' },
      note: 'For lunch yesterday',
      status: 'pending',
    });
    expect(created.expiresAt).toBeDefined();

    const row = await ctx.moneyRequestRepo.findOneByOrFail({ id: created.id });
    expect(row.status).toBe('pending');
    expect(row.requesterUserId).toBe(requester.userId);
    expect(row.payerUserId).toBe(payer.userId);
  });

  it('rejects a self-request', async () => {
    const requester = await seedUser('self');

    await create(
      tokenFor(requester.userId),
      { payerUserId: requester.userId, amount: 500_000 },
      422,
    );
  });

  it('rejects an amount below the configured minimum', async () => {
    const requester = await seedUser('minreq');
    const payer = await seedUser('minpay');

    await create(
      tokenFor(requester.userId),
      { payerUserId: payer.userId, amount: 9_999 },
      422,
    );
  });

  it('rejects an amount above the configured maximum', async () => {
    const requester = await seedUser('maxreq');
    const payer = await seedUser('maxpay');

    await create(
      tokenFor(requester.userId),
      { payerUserId: payer.userId, amount: 100_000_001 },
      422,
    );
  });

  it('rejects a request against a payer that does not exist', async () => {
    const requester = await seedUser('nopay');

    await create(
      tokenFor(requester.userId),
      {
        payerUserId: '00000000-0000-4000-8000-000000000000',
        amount: 500_000,
      },
      404,
    );
  });

  describe('pair cap', () => {
    it('rejects a 4th outstanding request with a distinct error, but expired ones do not count', async () => {
      const requester = await seedUser('capreq');
      const payer = await seedUser('cappay');

      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const created = await create(
          tokenFor(requester.userId),
          { payerUserId: payer.userId, amount: 10_000 },
          201,
        );
        ids.push(created.id);
      }

      const fourthRes = await request(ctx.app.getHttpServer())
        .post('/money-requests')
        .set('Authorization', `Bearer ${tokenFor(requester.userId)}`)
        .send({ payerUserId: payer.userId, amount: 10_000 })
        .expect(422);
      expect((fourthRes.body as { message: string }).message).toMatch(
        /outstanding requests/,
      );

      // Backdate all three so they're `pending` in the row but expired in
      // practice — nothing sweeps `status` (ADR-0012).
      const past = new Date(Date.now() - 60_000);
      await ctx.moneyRequestRepo.update({ id: ids[0] }, { expiresAt: past });
      await ctx.moneyRequestRepo.update({ id: ids[1] }, { expiresAt: past });
      await ctx.moneyRequestRepo.update({ id: ids[2] }, { expiresAt: past });

      await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 10_000 },
        201,
      );
    });
  });

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
  });

  describe('visibility', () => {
    it('scopes incoming/outgoing lists to the two actual parties', async () => {
      const requester = await seedUser('visreq');
      const payer = await seedUser('vispay');
      const stranger = await seedUser('visstranger');
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 40_000 },
        201,
      );

      const outgoing = await listOutgoing(tokenFor(requester.userId));
      expect(outgoing.items.some((i) => i.id === created.id)).toBe(true);

      const incoming = await listIncoming(tokenFor(payer.userId));
      expect(incoming.items.some((i) => i.id === created.id)).toBe(true);

      const strangerOutgoing = await listOutgoing(tokenFor(stranger.userId));
      const strangerIncoming = await listIncoming(tokenFor(stranger.userId));
      expect(strangerOutgoing.items.some((i) => i.id === created.id)).toBe(
        false,
      );
      expect(strangerIncoming.items.some((i) => i.id === created.id)).toBe(
        false,
      );
    });

    it('shows a computed "expired" status in the list without ever storing it', async () => {
      const requester = await seedUser('expvisreq');
      const payer = await seedUser('expvispay');
      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 50_000 },
        201,
      );
      await ctx.moneyRequestRepo.update(
        { id: created.id },
        { expiresAt: new Date(Date.now() - 60_000) },
      );

      const outgoing = await listOutgoing(tokenFor(requester.userId));
      const item = outgoing.items.find((i) => i.id === created.id);
      expect(item?.status).toBe('expired');

      const row = await ctx.moneyRequestRepo.findOneByOrFail({
        id: created.id,
      });
      expect(row.status).toBe('pending');
    });
  });

  describe('notifications', () => {
    it('notifies the payer on create, across email, push, and in-app', async () => {
      const requester = await seedUser('notifycreatereq');
      const payer = await seedUser('notifycreatepay');
      await ctx.notificationService.registerPushToken(
        payer.userId,
        'android',
        `push-token-payer-${payer.userId}`,
      );
      const emailCountBefore = ctx.emailAdapter.sent.length;

      const created = await create(
        tokenFor(requester.userId),
        { payerUserId: payer.userId, amount: 60_000 },
        201,
      );

      await waitFor(async () => {
        const payerInApp = await ctx.notificationRepo.findBy({
          userId: payer.userId,
          type: 'money_request_created',
        });
        return payerInApp.length > 0;
      });

      const payerInApp = await ctx.notificationRepo.findBy({
        userId: payer.userId,
        type: 'money_request_created',
      });
      expect(payerInApp[0].dedupeKey).toBe(created.id);

      await waitFor(() => ctx.emailAdapter.sent.length >= emailCountBefore + 1);
      const newEmails = ctx.emailAdapter.sent.slice(emailCountBefore);
      expect(newEmails.some((m) => m.subject.includes('requested'))).toBe(true);

      expect(
        ctx.pushAdapter.sent.some(
          (m) => m.token === `push-token-payer-${payer.userId}`,
        ),
      ).toBe(true);
    });

    it('notifies the requester on decline, across email, push, and in-app — but never on cancel', async () => {
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
});
