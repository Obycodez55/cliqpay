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

describe('POST /money-requests/:id/pay', () => {
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
      phone: `+2348022${String(300_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
    };
  }

  async function seedRequester() {
    return seedTransferUser(ctx, nextIdentity('payreq'));
  }

  async function seedPayer(
    overrides: { pin?: string; balanceMinor?: bigint } = {},
  ) {
    const identity = nextIdentity('payer');
    const { userId, walletId } = await seedTransferUser(ctx, {
      ...identity,
      pin: overrides.pin,
    });
    if (overrides.balanceMinor) {
      await fundWallet(ctx, {
        reference: `cliqpay-payreq-fund-${userId}`,
        walletId,
        netAmountMinor: overrides.balanceMinor,
      });
    }
    return { userId, walletId };
  }

  async function createRequest(
    requesterId: string,
    payerId: string,
    amount: number,
    note?: string,
  ): Promise<MoneyRequestBody> {
    const res = await request(ctx.app.getHttpServer())
      .post('/money-requests')
      .set('Authorization', `Bearer ${tokenFor(requesterId)}`)
      .send({ payerUserId: payerId, amount, note })
      .expect(201);
    return res.body as MoneyRequestBody;
  }

  function pay(token: string, id: string, body: Record<string, unknown>) {
    return request(ctx.app.getHttpServer())
      .post(`/money-requests/${id}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('rejects an unauthenticated pay', async () => {
    await request(ctx.app.getHttpServer())
      .post(`/money-requests/${randomUUID()}/pay`)
      .send({})
      .expect(401);
  });

  it('pays end-to-end: balances move, request is paid, transaction is linked, notification lands', async () => {
    const requester = await seedRequester();
    const payer = await seedPayer({ balanceMinor: 5_000_000n });
    await ctx.notificationService.registerPushToken(
      requester.userId,
      'android',
      `push-token-req-${requester.userId}`,
    );
    const created = await createRequest(
      requester.userId,
      payer.userId,
      500_000,
      'For lunch',
    );
    const emailCountBefore = ctx.emailAdapter.sent.length;

    const res = await pay(tokenFor(payer.userId), created.id, {
      reference: `cliqpay-payreq-happy-${payer.userId}`,
      pin: '1234',
    }).expect(201);

    expect(res.body).toMatchObject({
      id: created.id,
      status: 'paid',
      amount: { amount: '500000', currency: 'NGN' },
    });

    const payerAccount = await ctx.accountRepo.findOneByOrFail({
      id: payer.walletId,
    });
    const requesterAccount = await ctx.accountRepo.findOneByOrFail({
      id: requester.walletId,
    });
    expect(payerAccount.balance).toBe(5_000_000n - 500_000n);
    expect(requesterAccount.balance).toBe(500_000n);

    const row = await ctx.moneyRequestRepo.findOneByOrFail({ id: created.id });
    expect(row.status).toBe('paid');
    expect(row.transactionId).not.toBeNull();
    const transaction = await ctx.transactionRepo.findOneByOrFail({
      id: row.transactionId!,
    });
    expect(transaction.type).toBe('p2p_transfer');
    expect(transaction.amount).toBe(500_000n);

    await waitFor(async () => {
      const requesterInApp = await ctx.notificationRepo.findBy({
        userId: requester.userId,
        type: 'money_request_paid',
      });
      return requesterInApp.length > 0;
    });
    const requesterInApp = await ctx.notificationRepo.findBy({
      userId: requester.userId,
      type: 'money_request_paid',
    });
    expect(requesterInApp[0].dedupeKey).toBe(created.id);

    await waitFor(() => ctx.emailAdapter.sent.length >= emailCountBefore + 1);
    const newEmails = ctx.emailAdapter.sent.slice(emailCountBefore);
    expect(newEmails.some((m) => m.subject.includes('paid'))).toBe(true);

    expect(
      ctx.pushAdapter.sent.some(
        (m) => m.token === `push-token-req-${requester.userId}`,
      ),
    ).toBe(true);
  });

  it('rejects pay from anyone other than the addressed payer', async () => {
    const requester = await seedRequester();
    const payer = await seedPayer({ balanceMinor: 5_000_000n });
    const stranger = await seedPayer({ balanceMinor: 5_000_000n });
    const created = await createRequest(
      requester.userId,
      payer.userId,
      100_000,
    );

    await pay(tokenFor(stranger.userId), created.id, {
      reference: `cliqpay-payreq-stranger-${stranger.userId}`,
      pin: '1234',
    }).expect(404);
  });

  it('rejects paying a request that does not exist', async () => {
    const payer = await seedPayer({ balanceMinor: 5_000_000n });

    await pay(tokenFor(payer.userId), randomUUID(), {
      reference: `cliqpay-payreq-noexist-${payer.userId}`,
      pin: '1234',
    }).expect(404);
  });

  it('rejects paying an expired request, even though status is still pending in the row', async () => {
    const requester = await seedRequester();
    const payer = await seedPayer({ balanceMinor: 5_000_000n });
    const created = await createRequest(
      requester.userId,
      payer.userId,
      100_000,
    );
    await ctx.moneyRequestRepo.update(
      { id: created.id },
      { expiresAt: new Date(Date.now() - 60_000) },
    );

    await pay(tokenFor(payer.userId), created.id, {
      reference: `cliqpay-payreq-expired-${payer.userId}`,
      pin: '1234',
    }).expect(422);

    const row = await ctx.moneyRequestRepo.findOneByOrFail({ id: created.id });
    expect(row.status).toBe('pending');
    const payerAccount = await ctx.accountRepo.findOneByOrFail({
      id: payer.walletId,
    });
    expect(payerAccount.balance).toBe(5_000_000n);
  });

  it('rejects paying a cancelled request', async () => {
    const requester = await seedRequester();
    const payer = await seedPayer({ balanceMinor: 5_000_000n });
    const created = await createRequest(
      requester.userId,
      payer.userId,
      100_000,
    );
    await request(ctx.app.getHttpServer())
      .post(`/money-requests/${created.id}/cancel`)
      .set('Authorization', `Bearer ${tokenFor(requester.userId)}`)
      .send()
      .expect(201);

    await pay(tokenFor(payer.userId), created.id, {
      reference: `cliqpay-payreq-cancelled-${payer.userId}`,
      pin: '1234',
    }).expect(422);
  });

  it('rejects paying a declined request', async () => {
    const requester = await seedRequester();
    const payer = await seedPayer({ balanceMinor: 5_000_000n });
    const created = await createRequest(
      requester.userId,
      payer.userId,
      100_000,
    );
    await request(ctx.app.getHttpServer())
      .post(`/money-requests/${created.id}/decline`)
      .set('Authorization', `Bearer ${tokenFor(payer.userId)}`)
      .send()
      .expect(201);

    await pay(tokenFor(payer.userId), created.id, {
      reference: `cliqpay-payreq-declined-${payer.userId}`,
      pin: '1234',
    }).expect(422);
  });

  it('rejects paying an already-paid request a second time with a different reference', async () => {
    const requester = await seedRequester();
    const payer = await seedPayer({ balanceMinor: 5_000_000n });
    const created = await createRequest(
      requester.userId,
      payer.userId,
      100_000,
    );

    await pay(tokenFor(payer.userId), created.id, {
      reference: `cliqpay-payreq-firstpay-${payer.userId}`,
      pin: '1234',
    }).expect(201);

    await pay(tokenFor(payer.userId), created.id, {
      reference: `cliqpay-payreq-secondpay-${payer.userId}`,
      pin: '1234',
    }).expect(422);

    const payerAccount = await ctx.accountRepo.findOneByOrFail({
      id: payer.walletId,
    });
    expect(payerAccount.balance).toBe(5_000_000n - 100_000n);
  });

  // The money_requests row lock only serializes concurrent attempts on the
  // *same* request — it has no relationship to a `reference` reused across
  // two different, still-pending requests. Both reach
  // TransfersService.finalizeTransfer's manager branch, and the second must
  // still get a clean 409 from the UQ_transactions_reference collision, not
  // an unhandled 500 from an aborted transaction.
  it('rejects a reference reused across two different pending requests with a clean 409, not a 500', async () => {
    const requester = await seedRequester();
    const payer = await seedPayer({ balanceMinor: 5_000_000n });
    const firstRequest = await createRequest(
      requester.userId,
      payer.userId,
      100_000,
    );
    const secondRequest = await createRequest(
      requester.userId,
      payer.userId,
      100_000,
    );
    const sharedReference = `cliqpay-payreq-shared-ref-${payer.userId}`;

    await pay(tokenFor(payer.userId), firstRequest.id, {
      reference: sharedReference,
      pin: '1234',
    }).expect(201);

    await pay(tokenFor(payer.userId), secondRequest.id, {
      reference: sharedReference,
      pin: '1234',
    }).expect(409);

    const secondRow = await ctx.moneyRequestRepo.findOneByOrFail({
      id: secondRequest.id,
    });
    expect(secondRow.status).toBe('pending');
    const payerAccount = await ctx.accountRepo.findOneByOrFail({
      id: payer.walletId,
    });
    expect(payerAccount.balance).toBe(5_000_000n - 100_000n);
  });

  it('rejects a wrong PIN with 401, leaving the request pending', async () => {
    const requester = await seedRequester();
    const payer = await seedPayer({ balanceMinor: 5_000_000n });
    const created = await createRequest(
      requester.userId,
      payer.userId,
      100_000,
    );

    await pay(tokenFor(payer.userId), created.id, {
      reference: `cliqpay-payreq-wrongpin-${payer.userId}`,
      pin: '0000',
    }).expect(401);

    const row = await ctx.moneyRequestRepo.findOneByOrFail({ id: created.id });
    expect(row.status).toBe('pending');
  });

  it('leaves insufficient-funds requests pending and payable once funded', async () => {
    const requester = await seedRequester();
    const payer = await seedPayer({ balanceMinor: 10_000n });
    const created = await createRequest(
      requester.userId,
      payer.userId,
      500_000,
    );

    await pay(tokenFor(payer.userId), created.id, {
      reference: `cliqpay-payreq-insufficient-${payer.userId}`,
      pin: '1234',
    }).expect(422);

    let row = await ctx.moneyRequestRepo.findOneByOrFail({ id: created.id });
    expect(row.status).toBe('pending');
    let payerAccount = await ctx.accountRepo.findOneByOrFail({
      id: payer.walletId,
    });
    expect(payerAccount.balance).toBe(10_000n);

    await fundWallet(ctx, {
      reference: `cliqpay-payreq-topup-${payer.userId}`,
      walletId: payer.walletId,
      netAmountMinor: 1_000_000n,
    });

    await pay(tokenFor(payer.userId), created.id, {
      reference: `cliqpay-payreq-retry-${payer.userId}`,
      pin: '1234',
    }).expect(201);

    row = await ctx.moneyRequestRepo.findOneByOrFail({ id: created.id });
    expect(row.status).toBe('paid');
    payerAccount = await ctx.accountRepo.findOneByOrFail({
      id: payer.walletId,
    });
    expect(payerAccount.balance).toBe(10_000n + 1_000_000n - 500_000n);
  });

  describe('idempotency', () => {
    it('replays the original result for a matching retry, without moving money twice', async () => {
      const requester = await seedRequester();
      const payer = await seedPayer({ balanceMinor: 5_000_000n });
      const created = await createRequest(
        requester.userId,
        payer.userId,
        200_000,
      );
      const reference = `cliqpay-payreq-replay-${payer.userId}`;

      const first = await pay(tokenFor(payer.userId), created.id, {
        reference,
        pin: '1234',
      }).expect(201);
      const second = await pay(tokenFor(payer.userId), created.id, {
        reference,
        pin: '1234',
      }).expect(201);

      expect(second.body).toEqual(first.body);
      const payerAccount = await ctx.accountRepo.findOneByOrFail({
        id: payer.walletId,
      });
      expect(payerAccount.balance).toBe(5_000_000n - 200_000n);
    });
  });

  describe('concurrency', () => {
    // Same shape as ledger-transfer-concurrency.integration-spec.ts's
    // double-spend test, aimed at the money_requests row lock instead of a
    // wallet balance — N concurrent pay attempts against one request must
    // yield exactly one winner, since the reference-based idempotency check
    // alone doesn't stop two attempts that use two different references
    // (see MoneyRequestsService.payRequest).
    it('lets exactly one of N concurrent pay attempts on the same request commit', async () => {
      const requester = await seedRequester();
      const payer = await seedPayer({ balanceMinor: 5_000_000n });
      const created = await createRequest(
        requester.userId,
        payer.userId,
        300_000,
      );
      const concurrency = 8;

      const results = await Promise.allSettled(
        Array.from({ length: concurrency }, (_, i) =>
          pay(tokenFor(payer.userId), created.id, {
            reference: `cliqpay-payreq-conc-${created.id}-${i}`,
            pin: '1234',
          }),
        ),
      );

      const succeeded = results.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 201,
      );
      expect(succeeded).toHaveLength(1);

      const row = await ctx.moneyRequestRepo.findOneByOrFail({
        id: created.id,
      });
      expect(row.status).toBe('paid');

      const payerAccount = await ctx.accountRepo.findOneByOrFail({
        id: payer.walletId,
      });
      expect(payerAccount.balance).toBe(5_000_000n - 300_000n);

      const transactions = await ctx.transactionRepo.find({
        where: { recipientWalletId: requester.walletId, type: 'p2p_transfer' },
      });
      expect(transactions).toHaveLength(1);
      expect(transactions[0].id).toBe(row.transactionId);
    });
  });
});
