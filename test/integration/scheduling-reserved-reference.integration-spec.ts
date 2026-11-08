import { randomUUID } from 'crypto';
import {
  TransfersTestContext,
  createTransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import { createSchedulingHelpers } from './support/scheduling-test-context';
import { TEST_INTERNAL_API_SECRET } from './support/test-app-config';
import { SchedulingModule } from '../../src/modules/scheduling/scheduling.module';
import { BillSplitModule } from '../../src/modules/billsplit/billsplit.module';
import { PaymentsModule } from '../../src/modules/payments/payments.module';
import { WithdrawalsModule } from '../../src/modules/withdrawals/withdrawals.module';
import { DisputesModule } from '../../src/modules/disputes/disputes.module';

jest.setTimeout(180_000);

describe('The sched_ reference prefix is reserved', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createTransfersTestContext(0, [
      SchedulingModule,
      BillSplitModule,
      PaymentsModule,
      WithdrawalsModule,
      DisputesModule,
    ]);
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  const reserved = (suffix = randomUUID()) => `sched_${suffix}`;

  const endpoints: {
    name: string;
    send: (
      h: ReturnType<typeof createSchedulingHelpers>,
      userId: string,
      reference: string,
    ) => import('supertest').Test;
  }[] = [
    {
      name: 'POST /transfers',
      send: (h, userId, reference) =>
        h
          .http()
          .post('/transfers')
          .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
          .send({
            recipientUserId: randomUUID(),
            amount: 100_000,
            visibility: 'private',
            pin: '1234',
            reference,
          }),
    },
    {
      name: 'POST /money-requests/:id/pay',
      send: (h, userId, reference) =>
        h
          .http()
          .post(`/money-requests/${randomUUID()}/pay`)
          .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
          .send({ pin: '1234', reference }),
    },
    {
      name: 'POST /bill-splits',
      send: (h, userId, reference) =>
        h
          .http()
          .post('/bill-splits')
          .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
          .send({
            reference,
            description: 'Dinner',
            mode: 'equal',
            total: 100_000,
            visibility: 'private',
            participants: [{ userId: randomUUID() }],
          }),
    },
    {
      name: 'POST /wallet/fund',
      send: (h, userId, reference) =>
        h
          .http()
          .post('/wallet/fund')
          .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
          .send({ amount: 100_000, reference }),
    },
    {
      name: 'POST /withdrawals',
      send: (h, userId, reference) =>
        h
          .http()
          .post('/withdrawals')
          .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
          .send({
            amount: 100_000,
            bankAccountId: randomUUID(),
            pin: '1234',
            reference,
          }),
    },
    {
      name: 'POST /disputes/chargebacks',
      send: (h, _userId, reference) =>
        h
          .http()
          .post('/disputes/chargebacks')
          .set('X-Internal-Secret', TEST_INTERNAL_API_SECRET)
          .send({
            fundingReference: 'cliqpay-fund-1',
            amount: 100_000,
            disputeReference: reference,
          }),
    },
    {
      name: 'POST /scheduled-payments',
      send: (h, userId, reference) =>
        h.createSchedule(userId, randomUUID(), { reference }),
    },
  ];

  it.each(endpoints)('rejects it with 400 on $name', async ({ send }) => {
    const user = await h.seedUser('client');

    for (const reference of [reserved(), 'sched_', 'SCHED_Upper']) {
      const res = await send(h, user.userId, reference);

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('must not start with');
    }
  });

  it.each(endpoints)(
    'does not reject an ordinary reference on $name for that reason',
    async ({ send }) => {
      const user = await h.seedUser('client');

      const res = await send(h, user.userId, `cliqpay-${randomUUID()}`);

      expect(JSON.stringify(res.body)).not.toContain('must not start with');
    },
  );
});
