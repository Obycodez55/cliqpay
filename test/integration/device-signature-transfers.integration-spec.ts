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
import { describeSignedAction } from './support/signed-actions';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

describe('device signatures on transfers', () => {
  let ctx: TransfersTestContext;
  let seq = 0;
  const jwtService = new JwtService({ secret: JWT_SECRET });

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0);
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  const tokenFor = (userId: string) =>
    jwtService.sign({ sub: userId, sid: 'test-session' });

  async function seedUser(prefix: string, balanceMinor?: bigint) {
    seq += 1;
    const user = await seedTransferUser(ctx, {
      email: `${prefix}-sig-${seq}@example.com`,
      phone: `+2348044${String(100_000 + seq).padStart(6, '0')}`,
      username: `${prefix}_sig_${seq}`,
    });
    if (balanceMinor) {
      await fundWallet(ctx, {
        reference: `cliqpay-sig-fund-${user.userId}`,
        walletId: user.walletId,
        netAmountMinor: balanceMinor,
      });
    }
    return user;
  }

  describeSignedAction(
    'POST /transfers',
    () => ctx,
    { tamper: ['reference', 'amount', 'target'], replays: true },
    async () => {
      const sender = await seedUser('sender', 5_000_000n);
      const recipient = await seedUser('recipient');
      const other = await seedUser('other');
      const reference = `cliqpay-xfer-sig-${randomUUID()}`;
      const body = {
        recipientUserId: recipient.userId,
        amount: 500_000,
        reference,
        pin: '1234',
        visibility: 'private',
      };
      const post =
        (payload: Record<string, unknown>) =>
        (headers: Record<string, string>) =>
          request(ctx.app.getHttpServer())
            .post('/transfers')
            .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
            .set(headers)
            .send(payload);
      return {
        userId: sender.userId,
        signs: {
          action: 'transfer.send',
          reference,
          amount: '500000',
          target: recipient.userId,
        },
        send: post(body),
        tampered: {
          reference: post({ ...body, reference: `${reference}-x` }),
          amount: post({ ...body, amount: 900_000 }),
          target: post({ ...body, recipientUserId: other.userId }),
        },
        expectApplied: async () => {
          const tx = await ctx.transactionRepo.find({ where: { reference } });
          expect(tx).toHaveLength(1);
        },
        expectUntouched: async () => {
          for (const ref of [reference, `${reference}-x`]) {
            expect(
              await ctx.transactionRepo.findOneBy({ reference: ref }),
            ).toBeNull();
          }
          const wallet = await ctx.accountRepo.findOneByOrFail({
            id: sender.walletId,
          });
          expect(wallet.balance).toBe(5_000_000n);
        },
      };
    },
  );

  describeSignedAction(
    'POST /money-requests/:id/pay',
    () => ctx,
    { tamper: ['reference', 'target'], replays: true },
    async () => {
      const requester = await seedUser('requester');
      const payer = await seedUser('payer', 5_000_000n);
      const create = async () =>
        dataOf<{ id: string }>(
          await request(ctx.app.getHttpServer())
            .post('/money-requests')
            .set('Authorization', `Bearer ${tokenFor(requester.userId)}`)
            .send({ payerUserId: payer.userId, amount: 100_000 })
            .expect(201),
        );
      const target = await create();
      const decoy = await create();
      const reference = `cliqpay-payreq-sig-${randomUUID()}`;
      const body = { reference, pin: '1234', visibility: 'private' };
      const post =
        (id: string, payload: Record<string, unknown>) =>
        (headers: Record<string, string>) =>
          request(ctx.app.getHttpServer())
            .post(`/money-requests/${id}/pay`)
            .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
            .set(headers)
            .send(payload);
      return {
        userId: payer.userId,
        signs: {
          action: 'money_request.pay',
          reference,
          amount: '',
          target: target.id,
        },
        send: post(target.id, body),
        tampered: {
          reference: post(target.id, { ...body, reference: `${reference}-x` }),
          target: post(decoy.id, body),
        },
        expectApplied: async () => {
          expect(
            (await ctx.moneyRequestRepo.findOneByOrFail({ id: target.id }))
              .status,
          ).toBe('paid');
        },
        expectUntouched: async () => {
          for (const id of [target.id, decoy.id]) {
            expect(
              (await ctx.moneyRequestRepo.findOneByOrFail({ id })).status,
            ).toBe('pending');
          }
        },
      };
    },
  );
});
