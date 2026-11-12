import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { FraudFlag } from '../../src/modules/risk/entities/fraud-flag.entity';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './support/transfers-test-context';
import { dataOf, errorOf } from './support/api-response';

jest.setTimeout(180_000);

const DAY_MS = 24 * 60 * 60 * 1000;
const THRESHOLD = 2_000_000;

describe('recipient risk warnings on payments', () => {
  let ctx: TransfersTestContext;
  let seq = 0;
  const jwtService = new JwtService({
    secret: 'test-jwt-secret-at-least-32-characters-long',
  });

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0);
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  const tokenFor = (userId: string) =>
    jwtService.sign({ sub: userId, sid: 'test-session' });

  async function seedUser(
    prefix: string,
    options: { ageMs?: number; balanceMinor?: bigint } = {},
  ) {
    seq += 1;
    const user = await seedTransferUser(ctx, {
      email: `${prefix}-rw-${seq}@example.com`,
      phone: `+2348066${String(100_000 + seq).padStart(6, '0')}`,
      username: `${prefix}_rw_${seq}`,
    });
    await ctx.userRepo.update(
      { id: user.userId },
      { createdAt: new Date(Date.now() - (options.ageMs ?? 30 * DAY_MS)) },
    );
    if (options.balanceMinor) {
      await fundWallet(ctx, {
        reference: `cliqpay-rw-fund-${user.userId}`,
        walletId: user.walletId,
        netAmountMinor: options.balanceMinor,
      });
    }
    return user;
  }

  const seedSender = () => seedUser('sender', { balanceMinor: 50_000_000n });

  const send = (
    senderId: string,
    body: Record<string, unknown>,
  ): request.Test =>
    request(ctx.app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${tokenFor(senderId)}`)
      .send({
        reference: `cliqpay-rw-${randomUUID()}`,
        amount: 100_000,
        pin: '1234',
        visibility: 'private',
        ...body,
      });

  const flagFor = (
    userId: string,
    overrides: Partial<FraudFlag> = {},
  ): Promise<FraudFlag> => {
    const repo = ctx.dataSource.getRepository(FraudFlag);
    return repo.save(
      repo.create({
        userId,
        kind: 'fraud',
        ruleCode: 'mule_fan_in',
        evidence: [{ seeded: true }],
        enforced: true,
        status: 'open',
        ...overrides,
      }),
    );
  };

  const metadataOf = async (reference: string) =>
    (await ctx.transactionRepo.findOneByOrFail({ reference }))
      .metadata as unknown as Record<string, unknown>;

  describe('POST /transfers', () => {
    it('lets a first payment just under the threshold through', async () => {
      const sender = await seedSender();
      const recipient = await seedUser('recipient');

      await send(sender.userId, {
        recipientUserId: recipient.userId,
        amount: THRESHOLD - 1,
      }).expect(201);
    });

    it('returns 422 for a first payment at the threshold, persisting nothing, then proceeds when acknowledged with the same reference', async () => {
      const sender = await seedSender();
      const recipient = await seedUser('recipient');
      const reference = `cliqpay-rw-${randomUUID()}`;
      const body = {
        recipientUserId: recipient.userId,
        amount: THRESHOLD,
        reference,
      };

      const blocked = await send(sender.userId, body).expect(422);

      expect(errorOf(blocked).code).toBe('RISK_ACKNOWLEDGEMENT_REQUIRED');
      expect(errorOf(blocked).details).toEqual({
        warnings: ['FIRST_PAYMENT_LARGE_AMOUNT'],
      });
      expect(await ctx.transactionRepo.findOneBy({ reference })).toBeNull();
      const wallet = await ctx.accountRepo.findOneByOrFail({
        id: sender.walletId,
      });
      expect(wallet.balance).toBe(50_000_000n);

      const ok = await send(sender.userId, {
        ...body,
        riskAcknowledged: true,
      }).expect(201);

      expect(dataOf<{ reference: string }>(ok).reference).toBe(reference);
      expect(await metadataOf(reference)).toMatchObject({
        riskAcknowledgement: { codes: ['FIRST_PAYMENT_LARGE_AMOUNT'] },
      });
    });

    it('does not warn on a large payment to a recipient already paid', async () => {
      const sender = await seedSender();
      const recipient = await seedUser('recipient');
      await send(sender.userId, {
        recipientUserId: recipient.userId,
        amount: 100_000,
      }).expect(201);

      const res = await send(sender.userId, {
        recipientUserId: recipient.userId,
        amount: THRESHOLD * 2,
      }).expect(201);

      const reference = dataOf<{ reference: string }>(res).reference;
      expect(await metadataOf(reference)).not.toHaveProperty(
        'riskAcknowledgement',
      );
    });

    it('returns the original result for a completed reference without warnings', async () => {
      const sender = await seedSender();
      const recipient = await seedUser('recipient');
      const body = {
        recipientUserId: recipient.userId,
        amount: THRESHOLD,
        reference: `cliqpay-rw-${randomUUID()}`,
      };
      const first = await send(sender.userId, {
        ...body,
        riskAcknowledged: true,
      }).expect(201);

      const repeat = await send(sender.userId, body).expect(201);

      expect(dataOf<{ transactionId: string }>(repeat).transactionId).toBe(
        dataOf<{ transactionId: string }>(first).transactionId,
      );
    });

    it('warns for an account under 7 days old, and not at exactly 7 days', async () => {
      const sender = await seedSender();
      const justUnder = await seedUser('recipient', {
        ageMs: 7 * DAY_MS - 60_000,
      });
      const atSeven = await seedUser('recipient', { ageMs: 7 * DAY_MS });

      const blocked = await send(sender.userId, {
        recipientUserId: justUnder.userId,
      }).expect(422);
      expect(errorOf(blocked).details).toEqual({
        warnings: ['RECIPIENT_NEW_ACCOUNT'],
      });

      await send(sender.userId, {
        recipientUserId: atSeven.userId,
      }).expect(201);
    });

    it('warns for a recipient with an enforced open flag and stores the acknowledgement', async () => {
      const sender = await seedSender();
      const recipient = await seedUser('recipient');
      await flagFor(recipient.userId);
      const reference = `cliqpay-rw-${randomUUID()}`;
      const body = { recipientUserId: recipient.userId, reference };

      const blocked = await send(sender.userId, body).expect(422);
      expect(errorOf(blocked).details).toEqual({
        warnings: ['RECIPIENT_UNUSUAL_ACTIVITY'],
      });
      expect(JSON.stringify(blocked.body)).not.toMatch(/report/i);

      await send(sender.userId, { ...body, riskAcknowledged: true }).expect(
        201,
      );
      const stored = (await metadataOf(reference)) as {
        riskAcknowledgement: { codes: string[]; acknowledgedAt: string };
      };
      expect(stored.riskAcknowledgement.codes).toEqual([
        'RECIPIENT_UNUSUAL_ACTIVITY',
      ]);
      expect(
        Number.isNaN(Date.parse(stored.riskAcknowledgement.acknowledgedAt)),
      ).toBe(false);
    });

    it.each([
      ['a shadow flag', { enforced: false }],
      ['a cleared flag', { status: 'cleared' as const }],
    ])('does not warn for %s', async (_label, overrides) => {
      const sender = await seedSender();
      const recipient = await seedUser('recipient');
      await flagFor(recipient.userId, overrides);

      await send(sender.userId, { recipientUserId: recipient.userId }).expect(
        201,
      );
    });

    it('lists every warning that applies at once', async () => {
      const sender = await seedSender();
      const recipient = await seedUser('recipient', { ageMs: DAY_MS });
      await flagFor(recipient.userId);

      const blocked = await send(sender.userId, {
        recipientUserId: recipient.userId,
        amount: THRESHOLD,
      }).expect(422);

      expect(errorOf(blocked).details).toEqual({
        warnings: [
          'FIRST_PAYMENT_LARGE_AMOUNT',
          'RECIPIENT_NEW_ACCOUNT',
          'RECIPIENT_UNUSUAL_ACTIVITY',
        ],
      });
    });
  });

  describe('POST /money-requests/:id/pay', () => {
    const createRequest = async (
      requesterId: string,
      payerId: string,
      amount: number,
    ) =>
      dataOf<{ id: string }>(
        await request(ctx.app.getHttpServer())
          .post('/money-requests')
          .set('Authorization', `Bearer ${tokenFor(requesterId)}`)
          .send({ payerUserId: payerId, amount })
          .expect(201),
      );

    const pay = (payerId: string, id: string, body: Record<string, unknown>) =>
      request(ctx.app.getHttpServer())
        .post(`/money-requests/${id}/pay`)
        .set('Authorization', `Bearer ${tokenFor(payerId)}`)
        .send({ pin: '1234', visibility: 'private', ...body });

    it('requires acknowledgement, leaves the request pending, then pays with the same reference', async () => {
      const requester = await seedUser('requester', { ageMs: DAY_MS });
      const payer = await seedSender();
      const mr = await createRequest(requester.userId, payer.userId, 100_000);
      const reference = `cliqpay-rw-pay-${randomUUID()}`;

      const blocked = await pay(payer.userId, mr.id, { reference }).expect(422);

      expect(errorOf(blocked).code).toBe('RISK_ACKNOWLEDGEMENT_REQUIRED');
      expect(errorOf(blocked).details).toEqual({
        warnings: ['RECIPIENT_NEW_ACCOUNT'],
      });
      expect(await ctx.transactionRepo.findOneBy({ reference })).toBeNull();
      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: mr.id })).status,
      ).toBe('pending');

      await pay(payer.userId, mr.id, {
        reference,
        riskAcknowledged: true,
      }).expect(201);

      expect(await metadataOf(reference)).toMatchObject({
        riskAcknowledgement: { codes: ['RECIPIENT_NEW_ACCOUNT'] },
      });
    });

    it('returns the original result for a repeated reference without warnings', async () => {
      const requester = await seedUser('requester', { ageMs: DAY_MS });
      const payer = await seedSender();
      const mr = await createRequest(requester.userId, payer.userId, 100_000);
      const reference = `cliqpay-rw-pay-${randomUUID()}`;
      await pay(payer.userId, mr.id, {
        reference,
        riskAcknowledged: true,
      }).expect(201);

      await pay(payer.userId, mr.id, { reference }).expect(201);
    });

    it('warns on a first payment at the threshold', async () => {
      const requester = await seedUser('requester');
      const payer = await seedSender();
      const mr = await createRequest(requester.userId, payer.userId, THRESHOLD);

      const blocked = await pay(payer.userId, mr.id, {
        reference: `cliqpay-rw-pay-${randomUUID()}`,
      }).expect(422);

      expect(errorOf(blocked).details).toEqual({
        warnings: ['FIRST_PAYMENT_LARGE_AMOUNT'],
      });
    });
  });
});
