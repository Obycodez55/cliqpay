import { createHmac } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  fundWallet,
  seedBankAccount,
  seedWithdrawalUser,
} from './support/withdrawals-test-context';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const FAKE_SECRET_KEY = 'fake-kora-secret-key'; // matches FakeAdapter's fixed secret

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

interface KoraPayoutWebhookData {
  reference: string;
  status: string;
  amount: string;
  message?: string;
}

// event reflects data.status — Kora's real payload pairs `transfer.success`
// with a "success" data.status and `transfer.failed` with "failed" (see
// developers.korapay.com/docs/webhooks); handleKoraWebhook dispatches on
// `event` to route here at all, then reads `data.status` to decide the
// branch within that route.
function signedPayoutWebhookBody(
  data: KoraPayoutWebhookData,
  secret = FAKE_SECRET_KEY,
) {
  const event =
    data.status === 'failed' ? 'transfer.failed' : 'transfer.success';
  const body = JSON.stringify({ event, data });
  const signature = createHmac('sha256', secret)
    .update(JSON.stringify(data))
    .digest('hex');
  return { body, signature };
}

// Same physical endpoint as payments-funding-webhook.integration-spec's
// POST /wallet/webhook/kora — Kora delivers every event type to one
// dashboard-configured URL (issue #29's design correction; see
// PaymentsService.handleKoraWebhook). Kept as its own spec file per this
// repo's per-feature-area test-splitting convention, covering the
// transfer.* branch specifically.
describe('POST /wallet/webhook/kora (payout events)', () => {
  let ctx: WithdrawalsTestContext;
  let jwtService: JwtService;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext({ providerFee: 3_000 });
    jwtService = new JwtService({ secret: JWT_SECRET });
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  function nextIdentity(prefix: string) {
    idSeq += 1;
    const n = idSeq;
    return {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348055${String(300_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
    };
  }

  async function seedFundedSenderWithBankAccount() {
    const identity = nextIdentity('payout-wh');
    const { userId, walletId } = await seedWithdrawalUser(ctx, identity);
    await fundWallet(ctx, {
      reference: `cliqpay-fund-${userId}`,
      walletId,
      netAmountMinor: 5_000_000n,
    });
    const bankAccount = await seedBankAccount(ctx, {
      userId,
      accountNumber: `000001${String(idSeq).padStart(4, '0')}`,
    });
    return { userId, walletId, bankAccount, email: identity.email };
  }

  // Seeds a `pending` withdrawal transaction via the real initiate flow —
  // `accepted` is FakeAdapter's default outcome for any reference not
  // carrying the "reject"/"unknown" sentinels (see fake.adapter.ts).
  async function initiateAcceptedWithdrawal(
    sender: Awaited<ReturnType<typeof seedFundedSenderWithBankAccount>>,
    reference: string,
    amountMinor = 500_000,
  ): Promise<void> {
    await request(ctx.app.getHttpServer())
      .post('/withdrawals')
      .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
      .send({
        bankAccountId: sender.bankAccount.id,
        amount: amountMinor,
        reference,
        pin: '1234',
      })
      .expect(201);
  }

  function postPayoutWebhook(body: string, signature: string) {
    return request(ctx.app.getHttpServer())
      .post('/wallet/webhook/kora')
      .set('Content-Type', 'application/json')
      .set('x-korapay-signature', signature)
      .send(body);
  }

  it('completes a pending withdrawal (accepted payout) on a success webhook, posting no new ledger entries', async () => {
    const sender = await seedFundedSenderWithBankAccount();
    const reference = `cliqpay-wd-wh-success-${sender.userId}`;
    await initiateAcceptedWithdrawal(sender, reference);

    const pending = await ctx.transactionRepo.findOneByOrFail({ reference });
    expect(pending.status).toBe('pending');
    const walletBefore = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });

    const { body, signature } = signedPayoutWebhookBody({
      reference,
      status: 'success',
      amount: '5000.00',
    });
    await postPayoutWebhook(body, signature).expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('completed');

    const entries = await ctx.ledgerEntryRepo.find({
      where: { transactionId: transaction.id },
    });
    expect(entries).toHaveLength(5); // unchanged from initiation — no new legs

    const walletAfter = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });
    expect(walletAfter.balance).toBe(walletBefore.balance);

    // .some/.find by recipient alone would match the earlier
    // withdrawal_initiated email sent by initiateAcceptedWithdrawal above —
    // filter by the completion subject specifically.
    const completedSubject = 'Your withdrawal of NGN 5000.00 is complete';
    await waitFor(() =>
      ctx.emailAdapter.sent.some(
        (m) => m.to === sender.email && m.subject === completedSubject,
      ),
    );
  });

  it('resolves a transaction left pending by an `unknown` payout outcome', async () => {
    const sender = await seedFundedSenderWithBankAccount();
    // FakeAdapter's unknown-outcome sentinel — see fake.adapter.ts. This is
    // the scenario issue #29 exists for: initiateWithdrawal leaves this
    // pending without reversing (see withdrawals-initiate.integration-spec's
    // "ambiguous payout outcome" tests), and only this webhook can resolve it.
    const unknownReference = `cliqpay-wd-wh-unknownoutcome-${sender.userId}`;
    await request(ctx.app.getHttpServer())
      .post('/withdrawals')
      .set('Authorization', `Bearer ${tokenFor(sender.userId)}`)
      .send({
        bankAccountId: sender.bankAccount.id,
        amount: 400_000,
        reference: unknownReference,
        pin: '1234',
      })
      .expect(201);

    const pending = await ctx.transactionRepo.findOneByOrFail({
      reference: unknownReference,
    });
    expect(pending.status).toBe('pending');

    const { body, signature } = signedPayoutWebhookBody({
      reference: unknownReference,
      status: 'success',
      amount: '4000.00',
    });
    await postPayoutWebhook(body, signature).expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference: unknownReference,
    });
    expect(transaction.status).toBe('completed');
  });

  it('reverses the withdrawal on a failure-reported webhook', async () => {
    const sender = await seedFundedSenderWithBankAccount();
    const reference = `cliqpay-wd-wh-failed-${sender.userId}`;
    await initiateAcceptedWithdrawal(sender, reference);

    const walletBefore = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });

    const { body, signature } = signedPayoutWebhookBody({
      reference,
      status: 'failed',
      amount: '5000.00',
      message: 'Beneficiary account closed',
    });
    await postPayoutWebhook(body, signature).expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('reversed');

    const reversal = await ctx.transactionRepo.findOneByOrFail({
      reference: `${reference}-reversal`,
    });
    expect(reversal).toMatchObject({
      type: 'withdrawal_reversal',
      status: 'completed',
      reversesTransactionId: transaction.id,
    });

    const walletAfter = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });
    expect(walletAfter.balance).toBe(walletBefore.balance + 503_000n);

    // Same reasoning as the success test above — filter by the failure
    // subject, not just recipient, since initiateAcceptedWithdrawal already
    // sent a withdrawal_initiated email to the same address.
    const failedSubject = 'Your withdrawal of NGN 5000.00 failed';
    await waitFor(() =>
      ctx.emailAdapter.sent.some(
        (m) => m.to === sender.email && m.subject === failedSubject,
      ),
    );
  });

  it('is idempotent — a redelivered success webhook is a no-op, not a double completion', async () => {
    const sender = await seedFundedSenderWithBankAccount();
    const reference = `cliqpay-wd-wh-dup-success-${sender.userId}`;
    await initiateAcceptedWithdrawal(sender, reference);

    const { body, signature } = signedPayoutWebhookBody({
      reference,
      status: 'success',
      amount: '5000.00',
    });
    await postPayoutWebhook(body, signature).expect(200);
    await postPayoutWebhook(body, signature).expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('completed');
    const entries = await ctx.ledgerEntryRepo.find({
      where: { transactionId: transaction.id },
    });
    expect(entries).toHaveLength(5);
  });

  it('is idempotent — a redelivered failure webhook is a no-op, not a double reversal', async () => {
    const sender = await seedFundedSenderWithBankAccount();
    const reference = `cliqpay-wd-wh-dup-failed-${sender.userId}`;
    await initiateAcceptedWithdrawal(sender, reference);

    const { body, signature } = signedPayoutWebhookBody({
      reference,
      status: 'failed',
      amount: '5000.00',
    });
    await postPayoutWebhook(body, signature).expect(200);
    await postPayoutWebhook(body, signature).expect(200);

    const reversals = await ctx.transactionRepo.findBy({
      reference: `${reference}-reversal`,
    });
    expect(reversals).toHaveLength(1);
  });

  it('rejects an invalid signature with 401, leaving the transaction pending', async () => {
    const sender = await seedFundedSenderWithBankAccount();
    const reference = `cliqpay-wd-wh-badsig-${sender.userId}`;
    await initiateAcceptedWithdrawal(sender, reference);

    const { body } = signedPayoutWebhookBody({
      reference,
      status: 'success',
      amount: '5000.00',
    });

    await postPayoutWebhook(body, 'deadbeef'.repeat(8)).expect(401);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('pending');
  });

  it('rejects a malformed payload with 400, not an uncaught 500', async () => {
    const malformed = JSON.stringify({
      event: 'transfer.success',
      data: { reference: 'cliqpay-wd-wh-malformed-1', status: 'success' }, // amount missing
    });
    const signature = createHmac('sha256', FAKE_SECRET_KEY)
      .update(
        JSON.stringify({
          reference: 'cliqpay-wd-wh-malformed-1',
          status: 'success',
        }),
      )
      .digest('hex');

    await postPayoutWebhook(malformed, signature).expect(400);
  });

  it('leaves the transaction pending on a mismatched provider-reported amount, rather than completing on an unverified figure', async () => {
    const sender = await seedFundedSenderWithBankAccount();
    const reference = `cliqpay-wd-wh-mismatch-${sender.userId}`;
    await initiateAcceptedWithdrawal(sender, reference);

    const { body, signature } = signedPayoutWebhookBody({
      reference,
      status: 'success',
      amount: '1.00', // does not match the requested 5000.00
    });
    await postPayoutWebhook(body, signature).expect(200);

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('pending');
  });
});
