import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
  fundWallet,
  seedTransferUser,
} from './support/transfers-test-context';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

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

interface SendTransferBody {
  recipientUserId: string;
  amount: number;
  reference: string;
  pin: string;
}

describe('POST /transfers — zero platform fee (launch default)', () => {
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
      phone: `+2348033${String(300_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
    };
  }

  async function seedFundedSender(
    overrides: {
      pin?: string;
      emailVerified?: boolean;
      balanceMinor?: bigint;
    } = {},
  ) {
    const identity = nextIdentity('sender');
    const { userId, walletId } = await seedTransferUser(ctx, {
      ...identity,
      pin: overrides.pin,
      emailVerified: overrides.emailVerified,
    });
    await fundWallet(ctx, {
      reference: `cliqpay-fund-${userId}`,
      walletId,
      netAmountMinor: overrides.balanceMinor ?? 5_000_000n,
    });
    return { userId, walletId };
  }

  async function seedRecipient() {
    const identity = nextIdentity('recipient');
    return seedTransferUser(ctx, identity);
  }

  function send(token: string, body: Partial<SendTransferBody>) {
    return request(ctx.app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('rejects an unauthenticated request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/transfers')
      .send({})
      .expect(401);
  });

  it('sends money end-to-end: balances move, history shows both legs, fee reported as 0', async () => {
    const sender = await seedFundedSender();
    const recipient = await seedRecipient();

    const res = await send(tokenFor(sender.userId), {
      recipientUserId: recipient.userId,
      amount: 500_000,
      reference: `cliqpay-xfer-happy-${sender.userId}`,
      pin: '1234',
    }).expect(201);

    expect(res.body).toMatchObject({
      reference: `cliqpay-xfer-happy-${sender.userId}`,
      amount: { amount: '500000', currency: 'NGN' },
      fee: { amount: '0', currency: 'NGN' },
      recipientUserId: recipient.userId,
    });

    const senderAccount = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });
    const recipientAccount = await ctx.accountRepo.findOneByOrFail({
      id: recipient.walletId,
    });
    expect(senderAccount.balance).toBe(5_000_000n - 500_000n);
    expect(recipientAccount.balance).toBe(500_000n);

    const senderHistory = await request(ctx.app.getHttpServer())
      .get('/wallet/transactions')
      .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
      .expect(200);
    const senderTransferLeg = (
      senderHistory.body as { items: { type: string; direction: string }[] }
    ).items.find((i) => i.type === 'p2p_transfer');
    expect(senderTransferLeg).toMatchObject({
      type: 'p2p_transfer',
      direction: 'debit',
      status: 'completed',
    });

    const recipientHistory = await request(ctx.app.getHttpServer())
      .get('/wallet/transactions')
      .set('Authorization', `Bearer ${tokenFor(recipient.userId)}`)
      .expect(200);
    const recipientTransferLeg = (
      recipientHistory.body as { items: { type: string; direction: string }[] }
    ).items.find((i) => i.type === 'p2p_transfer');
    expect(recipientTransferLeg).toMatchObject({
      type: 'p2p_transfer',
      direction: 'credit',
      status: 'completed',
    });

    // Zero-fee posting is two-leg — no ledger_entries row for fee_income.
    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: `cliqpay-xfer-happy-${sender.userId}`,
    });
    const entries = await ctx.ledgerEntryRepo.find({
      where: { transactionId: transaction.id },
    });
    expect(entries).toHaveLength(2);
  });

  it('rejects sending to yourself', async () => {
    const sender = await seedFundedSender();

    await send(tokenFor(sender.userId), {
      recipientUserId: sender.userId,
      amount: 500_000,
      reference: `cliqpay-xfer-self-${sender.userId}`,
      pin: '1234',
    }).expect(422);
  });

  it('rejects an amount below the configured minimum', async () => {
    const sender = await seedFundedSender();
    const recipient = await seedRecipient();

    await send(tokenFor(sender.userId), {
      recipientUserId: recipient.userId,
      amount: 9_999,
      reference: `cliqpay-xfer-min-${sender.userId}`,
      pin: '1234',
    }).expect(422);
  });

  it('rejects an amount above the configured maximum', async () => {
    const sender = await seedFundedSender({ balanceMinor: 200_000_000n });
    const recipient = await seedRecipient();

    await send(tokenFor(sender.userId), {
      recipientUserId: recipient.userId,
      amount: 100_000_001,
      reference: `cliqpay-xfer-max-${sender.userId}`,
      pin: '1234',
    }).expect(422);
  });

  it("rejects when the sender's email is not verified", async () => {
    const sender = await seedFundedSender({ emailVerified: false });
    const recipient = await seedRecipient();

    await send(tokenFor(sender.userId), {
      recipientUserId: recipient.userId,
      amount: 500_000,
      reference: `cliqpay-xfer-unverified-${sender.userId}`,
      pin: '1234',
    }).expect(403);
  });

  it('rejects a transfer to a recipient that does not exist', async () => {
    const sender = await seedFundedSender();

    await send(tokenFor(sender.userId), {
      recipientUserId: '00000000-0000-4000-8000-000000000000',
      amount: 500_000,
      reference: `cliqpay-xfer-norecipient-${sender.userId}`,
      pin: '1234',
    }).expect(404);
  });

  it('rejects insufficient funds with a distinct 422, without moving anything', async () => {
    const sender = await seedFundedSender({ balanceMinor: 100_000n });
    const recipient = await seedRecipient();

    await send(tokenFor(sender.userId), {
      recipientUserId: recipient.userId,
      amount: 500_000,
      reference: `cliqpay-xfer-insufficient-${sender.userId}`,
      pin: '1234',
    }).expect(422);

    const senderAccount = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });
    expect(senderAccount.balance).toBe(100_000n);
  });

  it('rejects a wrong PIN with 401', async () => {
    const sender = await seedFundedSender();
    const recipient = await seedRecipient();

    await send(tokenFor(sender.userId), {
      recipientUserId: recipient.userId,
      amount: 500_000,
      reference: `cliqpay-xfer-wrongpin-${sender.userId}`,
      pin: '0000',
    }).expect(401);
  });

  it('locks the PIN after 3 failed attempts, blocking further sends with 423', async () => {
    const sender = await seedFundedSender();
    const recipient = await seedRecipient();

    for (let i = 0; i < 3; i++) {
      await send(tokenFor(sender.userId), {
        recipientUserId: recipient.userId,
        amount: 500_000,
        reference: `cliqpay-xfer-lockout-${sender.userId}-${i}`,
        pin: '0000',
      }).expect(401);
    }

    await send(tokenFor(sender.userId), {
      recipientUserId: recipient.userId,
      amount: 500_000,
      reference: `cliqpay-xfer-lockout-${sender.userId}-final`,
      pin: '1234',
    }).expect(423);
  });

  describe('idempotency', () => {
    it('replays the original result for a matching retry, without moving money twice', async () => {
      const sender = await seedFundedSender();
      const recipient = await seedRecipient();
      const reference = `cliqpay-xfer-replay-${sender.userId}`;
      const body = {
        recipientUserId: recipient.userId,
        amount: 500_000,
        reference,
        pin: '1234',
      };

      const first = await send(tokenFor(sender.userId), body).expect(201);
      const second = await send(tokenFor(sender.userId), body).expect(201);

      expect(second.body).toEqual(first.body);
      const senderAccount = await ctx.accountRepo.findOneByOrFail({
        id: sender.walletId,
      });
      expect(senderAccount.balance).toBe(5_000_000n - 500_000n);
    });

    it('rejects a reference already used by a different sender with 409', async () => {
      const senderA = await seedFundedSender();
      const senderB = await seedFundedSender();
      const recipient = await seedRecipient();
      const reference = `cliqpay-xfer-foreign-${senderA.userId}`;

      await send(tokenFor(senderA.userId), {
        recipientUserId: recipient.userId,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(201);

      await send(tokenFor(senderB.userId), {
        recipientUserId: recipient.userId,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(409);
    });

    it('rejects a reference reused with a different amount with 422', async () => {
      const sender = await seedFundedSender();
      const recipient = await seedRecipient();
      const reference = `cliqpay-xfer-diverged-${sender.userId}`;

      await send(tokenFor(sender.userId), {
        recipientUserId: recipient.userId,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(201);

      await send(tokenFor(sender.userId), {
        recipientUserId: recipient.userId,
        amount: 600_000,
        reference,
        pin: '1234',
      }).expect(422);
    });
  });

  describe('notifications', () => {
    it('notifies both parties across email, push, and in-app', async () => {
      const sender = await seedFundedSender();
      const recipient = await seedRecipient();
      await ctx.notificationService.registerPushToken(
        sender.userId,
        'android',
        `push-token-sender-${sender.userId}`,
      );
      await ctx.notificationService.registerPushToken(
        recipient.userId,
        'android',
        `push-token-recipient-${recipient.userId}`,
      );
      const reference = `cliqpay-xfer-notify-${sender.userId}`;
      const emailCountBefore = ctx.emailAdapter.sent.length;

      await send(tokenFor(sender.userId), {
        recipientUserId: recipient.userId,
        amount: 500_000,
        reference,
        pin: '1234',
      }).expect(201);

      await waitFor(async () => {
        const senderInApp = await ctx.notificationRepo.findBy({
          userId: sender.userId,
          type: 'transfer_sent',
        });
        const recipientInApp = await ctx.notificationRepo.findBy({
          userId: recipient.userId,
          type: 'transfer_received',
        });
        return senderInApp.length > 0 && recipientInApp.length > 0;
      });

      const senderInApp = await ctx.notificationRepo.findBy({
        userId: sender.userId,
        type: 'transfer_sent',
      });
      expect(senderInApp[0].dedupeKey).toBe(reference);

      const recipientInApp = await ctx.notificationRepo.findBy({
        userId: recipient.userId,
        type: 'transfer_received',
      });
      expect(recipientInApp[0].dedupeKey).toBe(reference);

      await waitFor(() => ctx.emailAdapter.sent.length >= emailCountBefore + 2);
      const newEmails = ctx.emailAdapter.sent.slice(emailCountBefore);
      expect(newEmails.some((m) => m.subject.includes('sent'))).toBe(true);
      expect(newEmails.some((m) => m.subject.includes('received'))).toBe(true);

      expect(
        ctx.pushAdapter.sent.some(
          (m) => m.token === `push-token-sender-${sender.userId}`,
        ),
      ).toBe(true);
      expect(
        ctx.pushAdapter.sent.some(
          (m) => m.token === `push-token-recipient-${recipient.userId}`,
        ),
      ).toBe(true);
    });
  });
});

describe('POST /transfers — non-zero platform fee', () => {
  let ctx: TransfersTestContext;
  let jwtService: JwtService;

  beforeAll(async () => {
    ctx = await createTransfersTestContext(5_000);
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  it('posts a three-leg transfer — sender debited amount+fee, recipient credited amount, fee_income credited fee', async () => {
    const { userId: senderId, walletId: senderWalletId } =
      await seedTransferUser(ctx, {
        email: 'fee-sender@example.com',
        phone: '+2348055500001',
        username: 'fee_sender_user',
      });
    await fundWallet(ctx, {
      reference: 'cliqpay-fee-fund-1',
      walletId: senderWalletId,
      netAmountMinor: 5_000_000n,
    });
    const { userId: recipientId, walletId: recipientWalletId } =
      await seedTransferUser(ctx, {
        email: 'fee-recipient@example.com',
        phone: '+2348055500002',
        username: 'fee_recipient_user',
      });
    const feeIncomeBefore = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_income',
      currency: 'NGN',
    });

    const res = await request(ctx.app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${tokenFor(senderId)}`)
      .send({
        recipientUserId: recipientId,
        amount: 500_000,
        reference: 'cliqpay-fee-xfer-1',
        pin: '1234',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      amount: { amount: '500000', currency: 'NGN' },
      fee: { amount: '5000', currency: 'NGN' },
    });

    const senderAccount = await ctx.accountRepo.findOneByOrFail({
      id: senderWalletId,
    });
    const recipientAccount = await ctx.accountRepo.findOneByOrFail({
      id: recipientWalletId,
    });
    const feeIncomeAfter = await ctx.accountRepo.findOneByOrFail({
      role: 'fee_income',
      currency: 'NGN',
    });

    expect(senderAccount.balance).toBe(5_000_000n - 505_000n);
    expect(recipientAccount.balance).toBe(500_000n);
    expect(feeIncomeAfter.balance).toBe(feeIncomeBefore.balance + 5_000n);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: 'cliqpay-fee-xfer-1',
    });
    const entries = await ctx.ledgerEntryRepo.find({
      where: { transactionId: transaction.id },
    });
    expect(entries).toHaveLength(3);
  });
});
