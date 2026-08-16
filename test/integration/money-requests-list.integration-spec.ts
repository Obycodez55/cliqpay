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

describe('GET /money-requests/incoming and /outgoing', () => {
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
    expect(strangerOutgoing.items.some((i) => i.id === created.id)).toBe(false);
    expect(strangerIncoming.items.some((i) => i.id === created.id)).toBe(false);
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
