import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  SplitBody,
  createBillSplitHelpers,
  createBillSplitTestContext,
} from './support/billsplit-test-context';
import { dataOf, errorOf } from './support/api-response';

jest.setTimeout(180_000);

describe('POST /bill-splits — concurrency', () => {
  let ctx: TransfersTestContext;
  const h = createBillSplitHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createBillSplitTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  it('runs concurrent splits from one initiator over the same participants without deadlock, respecting the pair cap', async () => {
    const initiator = await h.seedUser('initiator');
    const group = await Promise.all(
      Array.from({ length: 4 }, () => h.seedUser('member')),
    );
    const orders = [
      group,
      [...group].reverse(),
      [group[2], group[0], group[3], group[1]],
      [group[1], group[3], group[0], group[2]],
      group,
      [...group].reverse(),
    ];

    const responses = await Promise.all(
      orders.map((order, i) =>
        h.createSplit(initiator.userId, {
          description: `Concurrent ${i}`,
          total: 100_000,
          participants: order.map((u) => ({ userId: u.userId })),
        }),
      ),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 422, 422, 422]);
    for (const failed of responses.filter((r) => r.status === 422)) {
      expect(errorOf(failed).code).toBe('MONEY_REQUEST_PAIR_CAP_EXCEEDED');
    }

    const created = responses
      .filter((r) => r.status === 201)
      .map((r) => dataOf<SplitBody>(r));
    expect(new Set(created.map((s) => s.id)).size).toBe(3);

    const cap = ctx.config.moneyRequests.maxPendingPerPair;
    for (const member of group) {
      expect(
        await ctx.moneyRequestRepo.countBy({
          requesterUserId: initiator.userId,
          payerUserId: member.userId,
        }),
      ).toBe(cap);
    }
    const [{ splits }] = await ctx.dataSource.query<{ splits: string }[]>(
      `SELECT count(*) AS splits FROM bill_splits WHERE initiator_user_id = $1`,
      [initiator.userId],
    );
    expect(Number(splits)).toBe(3);
    const [{ participants }] = await ctx.dataSource.query<
      { participants: string }[]
    >(
      `SELECT count(*) AS participants FROM bill_split_participants bp
       JOIN bill_splits bs ON bs.id = bp.bill_split_id
       WHERE bs.initiator_user_id = $1`,
      [initiator.userId],
    );
    expect(Number(participants)).toBe(12);
  });

  it('lets a split race a plain money request to the same participant without exceeding the cap', async () => {
    const initiator = await h.seedUser('initiator');
    const [a, b] = await Promise.all([
      h.seedUser('member'),
      h.seedUser('member'),
    ]);

    const results = await Promise.all([
      ...Array.from({ length: 3 }, () =>
        h
          .http()
          .post('/money-requests')
          .set('Authorization', `Bearer ${h.tokenFor(initiator.userId)}`)
          .send({ payerUserId: a.userId, amount: 10_000 }),
      ),
      ...Array.from({ length: 3 }, () =>
        h.createSplit(initiator.userId, {
          total: 100_000,
          participants: [{ userId: a.userId }, { userId: b.userId }],
        }),
      ),
    ]);

    expect(results.every((r) => r.status === 201 || r.status === 422)).toBe(
      true,
    );
    expect(
      await ctx.moneyRequestRepo.countBy({
        requesterUserId: initiator.userId,
        payerUserId: a.userId,
      }),
    ).toBe(3);
  });
});
