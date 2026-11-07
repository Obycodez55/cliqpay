import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf } from './support/api-response';

jest.setTimeout(300_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const ROUNDS = 25;

describe('paying a money request racing a cancel or decline', () => {
  let ctx: TransfersTestContext;
  let jwtService: JwtService;
  let requester: { userId: string; walletId: string };
  let payer: { userId: string; walletId: string };

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0);
    jwtService = new JwtService({ secret: JWT_SECRET });
    requester = await seedTransferUser(ctx, {
      email: 'race-requester@example.com',
      phone: '+2348055000001',
      username: 'race_requester',
    });
    payer = await seedTransferUser(ctx, {
      email: 'race-payer@example.com',
      phone: '+2348055000002',
      username: 'race_payer',
    });
    await fundWallet(ctx, {
      reference: `cliqpay-race-fund-${payer.userId}`,
      walletId: payer.walletId,
      netAmountMinor: 20_000_000n,
    });
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  async function createRequest(): Promise<string> {
    const res = await request(ctx.app.getHttpServer())
      .post('/money-requests')
      .set('Authorization', `Bearer ${tokenFor(requester.userId)}`)
      .send({ payerUserId: payer.userId, amount: 10_000 })
      .expect(201);
    return dataOf<{ id: string }>(res).id;
  }

  function pay(id: string, reference: string) {
    return request(ctx.app.getHttpServer())
      .post(`/money-requests/${id}/pay`)
      .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
      .send({ reference, pin: '1234', visibility: 'private' });
  }

  function resolve(id: string, action: 'cancel' | 'decline') {
    const actor = action === 'cancel' ? requester : payer;
    return request(ctx.app.getHttpServer())
      .post(`/money-requests/${id}/${action}`)
      .set('Authorization', `Bearer ${tokenFor(actor.userId)}`)
      .send();
  }

  describe.each([
    ['cancel', 'cancelled'],
    ['decline', 'declined'],
  ] as const)('pay vs %s', (action, resolvedStatus) => {
    it('never leaves a status that disagrees with whether a transaction posted', async () => {
      const outcomes = { paid: 0, resolved: 0 };

      for (let round = 0; round < ROUNDS; round += 1) {
        const id = await createRequest();
        const reference = `cliqpay-race-${action}-${randomUUID()}`;

        const [payRes, resolveRes] = await Promise.all([
          pay(id, reference),
          resolve(id, action),
        ]);

        const row = await ctx.moneyRequestRepo.findOneByOrFail({ id });
        const posted = await ctx.transactionRepo.findOneBy({ reference });

        if (row.status === 'paid') {
          outcomes.paid += 1;
          expect(payRes.status).toBe(201);
          expect(resolveRes.status).toBe(404);
          expect(row.transactionId).toBe(posted?.id);
        } else {
          outcomes.resolved += 1;
          expect(row.status).toBe(resolvedStatus);
          expect(resolveRes.status).toBe(201);
          expect(payRes.status).toBe(422);
          expect(row.transactionId).toBeNull();
          expect(posted).toBeNull();
        }
      }

      expect(outcomes.paid + outcomes.resolved).toBe(ROUNDS);
    });
  });
});
