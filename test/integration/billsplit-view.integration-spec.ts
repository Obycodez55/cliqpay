import { randomUUID } from 'crypto';
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

jest.setTimeout(180_000);

describe('GET /bill-splits/:id — view', () => {
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
          description: 'Road trip fuel',
          total: 100_000,
          participants: participants.map((p) => ({ userId: p.userId })),
        })
        .expect(201),
    );
    const requestOf = (user: SplitUser) =>
      split.participants.find((p) => p.userId === user.userId)!.moneyRequestId;
    return { initiator, participants, split, requestOf };
  }

  it('rejects an unauthenticated view', async () => {
    await h.http().get(`/bill-splits/${randomUUID()}`).expect(401);
  });

  it('shows the initiator the description, total, own share, expiry and every participant', async () => {
    const { initiator, participants, split } = await seedSplit();

    const view = dataOf<SplitBody>(
      await h.getSplit(initiator.userId, split.id).expect(200),
    );

    expect(view).toMatchObject({
      id: split.id,
      description: 'Road trip fuel',
      total: { amount: '100000', currency: 'NGN' },
      initiatorShare: { amount: '25000', currency: 'NGN' },
      initiator: { userId: initiator.userId },
      status: 'open',
    });
    expect(view.expiresAt).toBe(split.expiresAt);
    expect(view.participants.map((p) => p.userId).sort()).toEqual(
      participants.map((p) => p.userId).sort(),
    );
    for (const participant of view.participants) {
      expect(participant).toMatchObject({
        share: { amount: '25000', currency: 'NGN' },
        status: 'pending',
      });
      expect(participant.username).toBeDefined();
      expect(participant.moneyRequestId).toBeDefined();
    }
  });

  it('shows every participant the whole split, other participants included', async () => {
    const { participants, split } = await seedSplit();

    for (const participant of participants) {
      const view = dataOf<SplitBody>(
        await h.getSplit(participant.userId, split.id).expect(200),
      );
      expect(view.participants).toHaveLength(3);
      expect(view.initiatorShare.amount).toBe('25000');
    }
  });

  it('returns the same 404 for an outsider and for an id that does not exist', async () => {
    const { split } = await seedSplit();
    const outsider = await h.seedUser('outsider');

    const hidden = await h.getSplit(outsider.userId, split.id).expect(404);
    const missing = await h.getSplit(outsider.userId, randomUUID()).expect(404);

    expect(errorOf(hidden)).toEqual(errorOf(missing));
  });

  it('keeps showing a split to a participant who blocked the initiator afterwards', async () => {
    const { initiator, participants, split } = await seedSplit(2);
    await h
      .http()
      .put(`/social/blocks/${initiator.userId}`)
      .set('Authorization', `Bearer ${h.tokenFor(participants[0].userId)}`)
      .expect(200);

    await h.getSplit(participants[0].userId, split.id).expect(200);
    await h.getSplit(initiator.userId, split.id).expect(200);
  });

  it('reads each share live from its money request: paid, declined, cancelled and pending', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit(4);
    const [paid, declined, cancelled, pending] = participants;

    await h.payRequest(paid.userId, requestOf(paid)).expect(201);
    await h
      .http()
      .post(`/money-requests/${requestOf(declined)}/decline`)
      .set('Authorization', `Bearer ${h.tokenFor(declined.userId)}`)
      .expect(201);
    await h
      .http()
      .post(`/money-requests/${requestOf(cancelled)}/cancel`)
      .set('Authorization', `Bearer ${h.tokenFor(initiator.userId)}`)
      .expect(201);

    const view = dataOf<SplitBody>(
      await h.getSplit(initiator.userId, split.id).expect(200),
    );
    const statusOf = (user: SplitUser) =>
      view.participants.find((p) => p.userId === user.userId)!.status;
    expect(statusOf(paid)).toBe('paid');
    expect(statusOf(declined)).toBe('declined');
    expect(statusOf(cancelled)).toBe('cancelled');
    expect(statusOf(pending)).toBe('pending');
    expect(view.status).toBe('open');
  });

  it('reads all statuses in one batched TransfersService read', async () => {
    const { initiator, split } = await seedSplit(5);
    const spy = jest.spyOn(ctx.transfersService, 'findMoneyRequestsByIds');
    try {
      await h.getSplit(initiator.userId, split.id).expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toHaveLength(5);
    } finally {
      spy.mockRestore();
    }
  });

  it('derives expired once past expiry with a share unpaid, showing pending shares as expired', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit(2);
    await h
      .payRequest(participants[0].userId, requestOf(participants[0]))
      .expect(201);
    const past = new Date(Date.now() - 60_000);
    await ctx.dataSource.query(
      `UPDATE bill_splits SET expires_at = $2 WHERE id = $1`,
      [split.id, past],
    );
    await ctx.moneyRequestRepo.update(
      { requesterUserId: initiator.userId },
      { expiresAt: past },
    );

    const view = dataOf<SplitBody>(
      await h.getSplit(initiator.userId, split.id).expect(200),
    );

    expect(view.status).toBe('expired');
    const statusOf = (id: string) =>
      view.participants.find((p) => p.userId === id)!.status;
    expect(statusOf(participants[0].userId)).toBe('paid');
    expect(statusOf(participants[1].userId)).toBe('expired');
  });

  it('does not mark a split expired when every share was paid', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit(2);
    for (const participant of participants) {
      await h
        .payRequest(participant.userId, requestOf(participant))
        .expect(201);
    }
    const past = new Date(Date.now() - 60_000);
    await ctx.dataSource.query(
      `UPDATE bill_splits SET expires_at = $2 WHERE id = $1`,
      [split.id, past],
    );

    const view = dataOf<SplitBody>(
      await h.getSplit(initiator.userId, split.id).expect(200),
    );
    expect(view.status).toBe('completed');
  });

  it('rejects a malformed id', async () => {
    const { initiator } = await seedSplit(1);
    await h.getSplit(initiator.userId, 'not-a-uuid').expect(400);
  });
});
