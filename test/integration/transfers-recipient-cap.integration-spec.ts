import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { Money } from '../../src/shared/primitives/money';
import { KycTier } from '../../src/modules/users/users.service';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './support/transfers-test-context';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const GENERIC_MESSAGE = "This recipient can't receive this amount right now.";
// Seeded tier1 balance cap (₦300,000), in kobo; the minimum transfer is 10,000.
const TIER1_CAP = 30_000_000n;
const MIN = 10_000;

describe('Recipient balance cap on incoming P2P transfers', () => {
  let ctx: TransfersTestContext;
  let jwtService: JwtService;
  let idSeq = 0;
  let refSeq = 0;

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0);
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  const tokenFor = (userId: string) =>
    jwtService.sign({ sub: userId, sid: 'test-session' });

  async function seedUser(tier: KycTier, balanceMinor = 0n, prefix = 'cap') {
    idSeq += 1;
    const n = idSeq;
    const { userId, walletId } = await seedTransferUser(ctx, {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348044${String(700_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
      kycTier: tier,
    });
    if (balanceMinor > 0n) {
      await fundWallet(ctx, {
        reference: `cliqpay-cap-fund-${userId}`,
        walletId,
        netAmountMinor: balanceMinor,
      });
    }
    return { userId, walletId };
  }

  const reference = () => {
    refSeq += 1;
    return `cliqpay-recipient-cap-${refSeq}`;
  };

  function send(
    senderId: string,
    recipientUserId: string,
    amount: number,
    ref = reference(),
  ) {
    return request(ctx.app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${tokenFor(senderId)}`)
      .send({ recipientUserId, amount, reference: ref, pin: '1234' });
  }

  async function balance(walletId: string) {
    return (await ctx.accountRepo.findOneByOrFail({ id: walletId })).balance;
  }

  it('lets a recipient land exactly on the cap', async () => {
    const sender = await seedUser('tier3', 100_000_000n, 'sender');
    const recipient = await seedUser('tier1', TIER1_CAP - BigInt(MIN));

    await send(sender.userId, recipient.userId, MIN).expect(201);

    expect(await balance(recipient.walletId)).toBe(TIER1_CAP);
  });

  it('rejects one kobo over the cap with a generic error that reveals nothing, posting nothing', async () => {
    const sender = await seedUser('tier3', 100_000_000n, 'sender');
    const recipient = await seedUser('tier1', TIER1_CAP - BigInt(MIN));
    const ref = reference();

    const res = await send(sender.userId, recipient.userId, MIN + 1, ref);

    expect(res.status).toBe(422);
    const text = JSON.stringify(res.body);
    expect(text).toContain(GENERIC_MESSAGE);
    for (const secret of [
      '30000000',
      '29990000',
      '300000',
      'tier1',
      'cap',
      'details',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(await ctx.transactionRepo.findOneBy({ reference: ref })).toBeNull();
    expect(await balance(recipient.walletId)).toBe(TIER1_CAP - BigInt(MIN));
    expect(await balance(sender.walletId)).toBe(100_000_000n);
  });

  it("counts the recipient's pending funding toward their cap", async () => {
    const sender = await seedUser('tier3', 100_000_000n, 'sender');
    const recipient = await seedUser('tier1');
    await ctx.ledgerService.createPendingFundingTransaction({
      reference: `cliqpay-cap-pending-${recipient.userId}`,
      provider: 'kora',
      providerReference: `cliqpay-cap-pending-${recipient.userId}`,
      amount: Money.of(TIER1_CAP - BigInt(MIN) + 1n, 'NGN'),
      recipientWalletId: recipient.walletId,
      metadata: { checkoutUrl: null, grossAmount: null },
    });

    await send(sender.userId, recipient.userId, MIN).expect(422);
  });

  it('rejects any transfer to a tier-0 recipient with the same generic error', async () => {
    const sender = await seedUser('tier3', 100_000_000n, 'sender');
    const recipient = await seedUser('tier0');

    const res = await send(sender.userId, recipient.userId, MIN);

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain(GENERIC_MESSAGE);
  });

  it('never caps a tier-3 recipient', async () => {
    const sender = await seedUser('tier3', 100_000_000n, 'sender');
    const recipient = await seedUser('tier3', 900_000_000_000n);

    await send(sender.userId, recipient.userId, MIN).expect(201);
  });

  it('replays an already-completed transfer even when the recipient is now at their cap', async () => {
    const sender = await seedUser('tier3', 100_000_000n, 'sender');
    const recipient = await seedUser('tier1');
    const ref = reference();
    const first = await send(sender.userId, recipient.userId, MIN, ref).expect(
      201,
    );
    await fundWallet(ctx, {
      reference: `cliqpay-cap-topup-${recipient.userId}`,
      walletId: recipient.walletId,
      netAmountMinor: TIER1_CAP,
    });

    const replay = await send(sender.userId, recipient.userId, MIN, ref);

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
  });

  it('rejects a money-request payment once the requester has since reached their cap, with the same generic error, leaving the request pending', async () => {
    const requester = await seedUser('tier1', TIER1_CAP - BigInt(MIN));
    const payer = await seedUser('tier3', 100_000_000n, 'payer');
    const created = await request(ctx.app.getHttpServer())
      .post('/money-requests')
      .set('Authorization', `Bearer ${tokenFor(requester.userId)}`)
      .send({ payerUserId: payer.userId, amount: MIN })
      .expect(201);
    await fundWallet(ctx, {
      reference: `cliqpay-cap-fill-${requester.userId}`,
      walletId: requester.walletId,
      netAmountMinor: 1n,
    });
    const ref = reference();

    const res = await request(ctx.app.getHttpServer())
      .post(`/money-requests/${(created.body as { id: string }).id}/pay`)
      .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
      .send({ reference: ref, pin: '1234' });

    expect(res.status).toBe(422);
    const text = JSON.stringify(res.body);
    expect(text).toContain(GENERIC_MESSAGE);
    for (const secret of ['30000000', '300000', 'tier1', 'cap', 'details']) {
      expect(text).not.toContain(secret);
    }
    const moneyRequest = await ctx.moneyRequestRepo.findOneByOrFail({
      id: (created.body as { id: string }).id,
    });
    expect(moneyRequest.status).toBe('pending');
    expect(await ctx.transactionRepo.findOneBy({ reference: ref })).toBeNull();
  });

  describe('concurrency', () => {
    it('never lets concurrent transfers overshoot one recipient’s cap', async () => {
      for (let round = 0; round < 3; round += 1) {
        const recipient = await seedUser('tier1');
        const senders = await Promise.all(
          Array.from({ length: 6 }, () => seedUser('tier3', 50_000_000n, 's')),
        );

        const results = await Promise.all(
          senders.map((s) => send(s.userId, recipient.userId, 10_000_000)),
        );

        expect(results.filter((r) => r.status === 201)).toHaveLength(3);
        expect(results.filter((r) => r.status === 422)).toHaveLength(3);
        expect(await balance(recipient.walletId)).toBe(TIER1_CAP);
      }
    });

    it('never deadlocks simultaneous A->B and B->A transfers', async () => {
      const a = await seedUser('tier3', 900_000_000n, 'a');
      const b = await seedUser('tier3', 900_000_000n, 'b');

      for (let round = 0; round < 25; round += 1) {
        const results = await Promise.all([
          send(a.userId, b.userId, MIN),
          send(b.userId, a.userId, MIN),
          send(a.userId, b.userId, MIN),
          send(b.userId, a.userId, MIN),
        ]);

        expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      }
    });
  });
});
