import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  SplitBody,
  SplitUser,
  createBillSplitHelpers,
  createBillSplitTestContext,
} from './support/billsplit-test-context';
import { dataOf, errorOf } from './support/api-response';
import { BillSplit } from '../../src/modules/billsplit/entities/bill-split.entity';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { MONEY_REQUEST_CANCELLED_EVENT } from '../../src/shared/events/domain-events';

jest.setTimeout(180_000);

const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe('POST /bill-splits/:id/cancel', () => {
  let ctx: TransfersTestContext;
  const h = createBillSplitHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createBillSplitTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedSplit(participantCount = 3) {
    const initiator = await h.seedUser('initiator');
    const participants: SplitUser[] = [];
    for (let i = 0; i < participantCount; i++) {
      participants.push(
        await h.seedUser('payer', { balanceMinor: 50_000_000n }),
      );
    }
    const split = dataOf<SplitBody>(
      await h
        .createSplit(initiator.userId, {
          total: 30_000 * participantCount,
          participants: participants.map((p) => ({ userId: p.userId })),
        })
        .expect(201),
    );
    const requestOf = (user: SplitUser) =>
      split.participants.find((p) => p.userId === user.userId)!.moneyRequestId;
    return { initiator, participants, split, requestOf };
  }

  const cancelSplit = (userId: string, splitId: string) =>
    h
      .http()
      .post(`/bill-splits/${splitId}/cancel`)
      .set('Authorization', `Bearer ${h.tokenFor(userId)}`);

  const decline = (userId: string, moneyRequestId: string) =>
    h
      .http()
      .post(`/money-requests/${moneyRequestId}/decline`)
      .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
      .expect(201);

  const row = (splitId: string) =>
    ctx.dataSource.getRepository(BillSplit).findOneByOrFail({ id: splitId });

  it('cancels every pending request, leaves paid and declined shares alone, and reports cancelled', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit(4);
    const [paid, declined, ...pending] = participants;
    await h.payRequest(paid.userId, requestOf(paid)).expect(201);
    await decline(declined.userId, requestOf(declined));
    await settle();
    const notificationsBefore = await ctx.notificationRepo.count();
    const publish = jest.spyOn(ctx.app.get(EventBusService), 'publish');

    const res = await cancelSplit(initiator.userId, split.id).expect(201);

    const body = dataOf<SplitBody>(res);
    expect(body.status).toBe('cancelled');
    const statusOf = (u: SplitUser) =>
      body.participants.find((p) => p.userId === u.userId)!.status;
    expect(statusOf(paid)).toBe('paid');
    expect(statusOf(declined)).toBe('declined');
    for (const p of pending) {
      expect(statusOf(p)).toBe('cancelled');
    }

    const stored = await row(split.id);
    expect(stored.cancelledAt).not.toBeNull();
    expect(stored.completedAt).toBeNull();
    expect(stored.closedAt).toBeNull();

    const cancelledEvents = publish.mock.calls.filter(
      ([event]) => event.name === MONEY_REQUEST_CANCELLED_EVENT,
    );
    expect(
      cancelledEvents
        .map(([e]) => (e.payload as { moneyRequestId: string }).moneyRequestId)
        .sort(),
    ).toEqual(pending.map(requestOf).sort());
    publish.mockRestore();

    await settle();
    expect(await ctx.notificationRepo.count()).toBe(notificationsBefore);
  });

  it('never marks a cancelled split completed or closed, even after more events and reads', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit(2);
    await h
      .payRequest(participants[0].userId, requestOf(participants[0]))
      .expect(201);
    await cancelSplit(initiator.userId, split.id).expect(201);

    await settle();
    await h.getSplit(initiator.userId, split.id).expect(200);
    await h.getSplit(participants[0].userId, split.id).expect(200);
    await settle();

    const stored = await row(split.id);
    expect(stored.cancelledAt).not.toBeNull();
    expect(stored.completedAt).toBeNull();
    expect(stored.closedAt).toBeNull();
    expect(
      (
        await ctx.moneyRequestRepo.findOneByOrFail({
          id: requestOf(participants[1]),
        })
      ).status,
    ).toBe('cancelled');
  });

  it('404s for anyone but the initiator, including participants', async () => {
    const { participants, split } = await seedSplit(2);
    const stranger = await h.seedUser('stranger');

    for (const user of [participants[0], stranger]) {
      const res = await cancelSplit(user.userId, split.id).expect(404);
      expect(errorOf(res).code).toBe('BILL_SPLIT_NOT_FOUND');
    }
    await cancelSplit(
      participants[0].userId,
      '00000000-0000-4000-8000-000000000000',
    ).expect(404);
    expect((await row(split.id)).cancelledAt).toBeNull();
  });

  it('rejects a split that is already cancelled, completed, closed or expired', async () => {
    const cancelled = await seedSplit(2);
    await cancelSplit(cancelled.initiator.userId, cancelled.split.id).expect(
      201,
    );
    const again = await cancelSplit(
      cancelled.initiator.userId,
      cancelled.split.id,
    ).expect(409);
    expect(errorOf(again).code).toBe('BILL_SPLIT_NOT_OPEN');

    const completed = await seedSplit(2);
    for (const p of completed.participants) {
      await h.payRequest(p.userId, completed.requestOf(p)).expect(201);
    }
    await cancelSplit(completed.initiator.userId, completed.split.id).expect(
      409,
    );

    const closed = await seedSplit(2);
    await decline(
      closed.participants[0].userId,
      closed.requestOf(closed.participants[0]),
    );
    await h
      .payRequest(
        closed.participants[1].userId,
        closed.requestOf(closed.participants[1]),
      )
      .expect(201);
    await cancelSplit(closed.initiator.userId, closed.split.id).expect(409);

    const expired = await seedSplit(2);
    await ctx.dataSource.query(
      `UPDATE bill_splits SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expired.split.id],
    );
    await ctx.dataSource.query(
      `UPDATE money_requests SET expires_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])`,
      [expired.participants.map(expired.requestOf)],
    );
    await cancelSplit(expired.initiator.userId, expired.split.id).expect(409);
    expect((await row(expired.split.id)).cancelledAt).toBeNull();
  });

  it('is atomic: a failure after the request cancels rolls the whole cancel back', async () => {
    const { initiator, split, participants, requestOf } = await seedSplit(2);
    await ctx.dataSource.query(
      `ALTER TABLE bill_splits ADD CONSTRAINT tmp_block_cancel CHECK (cancelled_at IS NULL) NOT VALID`,
    );
    try {
      await cancelSplit(initiator.userId, split.id).expect(500);
    } finally {
      await ctx.dataSource.query(
        `ALTER TABLE bill_splits DROP CONSTRAINT tmp_block_cancel`,
      );
    }

    expect((await row(split.id)).cancelledAt).toBeNull();
    for (const p of participants) {
      expect(
        (await ctx.moneyRequestRepo.findOneByOrFail({ id: requestOf(p) }))
          .status,
      ).toBe('pending');
    }
  });
});
