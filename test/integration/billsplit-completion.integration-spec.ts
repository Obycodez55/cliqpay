import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
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
import { dataOf } from './support/api-response';
import { BillSplit } from '../../src/modules/billsplit/entities/bill-split.entity';
import { BILL_SPLIT_EVENTS_QUEUE } from '../../src/modules/billsplit/internal/bill-split-events.queue';
import {
  MONEY_REQUEST_CANCELLED_EVENT,
  MONEY_REQUEST_PAID_EVENT,
} from '../../src/shared/events/domain-events';

jest.setTimeout(180_000);

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe('bill split completion and closing', () => {
  let ctx: TransfersTestContext;
  let queue: Queue;
  const h = createBillSplitHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createBillSplitTestContext();
    queue = ctx.app.get<Queue>(getQueueToken(BILL_SPLIT_EVENTS_QUEUE));
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedSplit(participantCount = 3) {
    const initiator = await h.seedUser('initiator');
    await ctx.notificationService.registerPushToken(
      initiator.userId,
      'android',
      `push-token-split-${initiator.userId}`,
    );
    const participants: SplitUser[] = [];
    for (let i = 0; i < participantCount; i++) {
      participants.push(
        await h.seedUser('payer', { balanceMinor: 50_000_000n }),
      );
    }
    const split = dataOf<SplitBody>(
      await h
        .createSplit(initiator.userId, {
          description: 'Dinner',
          total: 30_000 * participantCount,
          participants: participants.map((p) => ({ userId: p.userId })),
        })
        .expect(201),
    );
    const requestOf = (user: SplitUser) =>
      split.participants.find((p) => p.userId === user.userId)!.moneyRequestId;
    return { initiator, participants, split, requestOf };
  }

  const row = (splitId: string) =>
    ctx.dataSource.getRepository(BillSplit).findOneByOrFail({ id: splitId });

  const completionNotifications = (userId: string) =>
    ctx.notificationRepo.findBy({ userId, type: 'bill_split_completed' });

  const completionPushes = (userId: string) =>
    ctx.pushAdapter.sent.filter(
      (m) =>
        m.token === `push-token-split-${userId}` &&
        m.title === 'Split complete',
    );

  function decline(userId: string, moneyRequestId: string) {
    return h
      .http()
      .post(`/money-requests/${moneyRequestId}/decline`)
      .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
      .expect(201);
  }

  function cancel(userId: string, moneyRequestId: string) {
    return h
      .http()
      .post(`/money-requests/${moneyRequestId}/cancel`)
      .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
      .expect(201);
  }

  async function view(userId: string, splitId: string) {
    return dataOf<SplitBody>(await h.getSplit(userId, splitId).expect(200));
  }

  function replayEvent(name: string, moneyRequestId: string) {
    return queue.add(name, {
      name,
      payload: { moneyRequestId },
      occurredAt: new Date(),
    });
  }

  it('records completed_at and notifies the initiator once when every share is paid', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit();

    for (const p of participants) {
      await h.payRequest(p.userId, requestOf(p)).expect(201);
    }

    await waitFor(async () => (await row(split.id)).completedAt !== null);
    await waitFor(
      async () =>
        (await completionNotifications(initiator.userId)).length === 1,
    );
    await waitFor(() => completionPushes(initiator.userId).length === 1);

    expect((await row(split.id)).closedAt).toBeNull();
    const [notification] = await completionNotifications(initiator.userId);
    expect(notification.dedupeKey).toBe(split.id);
    expect((await view(initiator.userId, split.id)).status).toBe('completed');

    await settle();
    expect(await completionNotifications(initiator.userId)).toHaveLength(1);
    expect(completionPushes(initiator.userId)).toHaveLength(1);
  });

  it('does not complete or close while a share is still pending', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit();

    await h.payRequest(participants[0].userId, requestOf(participants[0]));
    await decline(participants[1].userId, requestOf(participants[1]));
    await settle();

    const stored = await row(split.id);
    expect(stored.completedAt).toBeNull();
    expect(stored.closedAt).toBeNull();
    expect((await view(initiator.userId, split.id)).status).toBe('open');
  });

  it('closes without a completion notification when a share is declined and the rest are paid', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit();

    await decline(participants[0].userId, requestOf(participants[0]));
    await h.payRequest(participants[1].userId, requestOf(participants[1]));
    await h.payRequest(participants[2].userId, requestOf(participants[2]));

    await waitFor(async () => (await row(split.id)).closedAt !== null);
    await settle();

    expect((await row(split.id)).completedAt).toBeNull();
    expect(await completionNotifications(initiator.userId)).toHaveLength(0);
    expect(completionPushes(initiator.userId)).toHaveLength(0);
    expect((await view(initiator.userId, split.id)).status).toBe('closed');
  });

  it('counts a per-request cancel of a share like a decline', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit();

    await cancel(initiator.userId, requestOf(participants[0]));
    await h.payRequest(participants[1].userId, requestOf(participants[1]));
    await h.payRequest(participants[2].userId, requestOf(participants[2]));

    await waitFor(async () => (await row(split.id)).closedAt !== null);
    expect((await row(split.id)).completedAt).toBeNull();
    expect(await completionNotifications(initiator.userId)).toHaveLength(0);
    expect((await view(initiator.userId, split.id)).status).toBe('closed');
  });

  it('is unharmed by duplicate and out-of-order events', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit();
    const [first, second, third] = participants;

    await replayEvent(MONEY_REQUEST_PAID_EVENT, requestOf(third));
    await replayEvent(MONEY_REQUEST_CANCELLED_EVENT, requestOf(second));
    await replayEvent(MONEY_REQUEST_PAID_EVENT, randomUUID());
    await settle();
    let stored = await row(split.id);
    expect(stored.completedAt).toBeNull();
    expect(stored.closedAt).toBeNull();

    for (const p of [third, second, first]) {
      await h.payRequest(p.userId, requestOf(p)).expect(201);
    }
    await waitFor(async () => (await row(split.id)).completedAt !== null);
    stored = await row(split.id);

    for (const p of participants) {
      await replayEvent(MONEY_REQUEST_PAID_EVENT, requestOf(p));
      await replayEvent(MONEY_REQUEST_PAID_EVENT, requestOf(p));
    }
    await replayEvent(MONEY_REQUEST_CANCELLED_EVENT, requestOf(first));
    await settle();

    const after = await row(split.id);
    expect(after.completedAt).toEqual(stored.completedAt);
    expect(after.closedAt).toBeNull();
    expect(await completionNotifications(initiator.userId)).toHaveLength(1);
    expect(completionPushes(initiator.userId)).toHaveLength(1);
  });

  it('recovers a lost event on read, and the late event then neither re-records nor re-notifies', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit(2);

    await queue.pause();
    try {
      for (const p of participants) {
        await h.payRequest(p.userId, requestOf(p)).expect(201);
      }
      await settle();
      expect((await row(split.id)).completedAt).toBeNull();

      const seen = await view(initiator.userId, split.id);
      expect(seen.status).toBe('completed');
      const repaired = await row(split.id);
      expect(repaired.completedAt).not.toBeNull();
      await waitFor(
        async () =>
          (await completionNotifications(initiator.userId)).length === 1,
      );

      await queue.resume();
      await settle();
      expect((await row(split.id)).completedAt).toEqual(repaired.completedAt);
    } finally {
      await queue.resume();
    }

    await view(initiator.userId, split.id);
    await settle();
    expect(await completionNotifications(initiator.userId)).toHaveLength(1);
    expect(completionPushes(initiator.userId)).toHaveLength(1);
  });

  it('repairs closed_at on read when the events were lost', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit(2);

    await queue.pause();
    try {
      await decline(participants[0].userId, requestOf(participants[0]));
      await h.payRequest(participants[1].userId, requestOf(participants[1]));
      await queue.drain();
      await settle();
      expect((await row(split.id)).closedAt).toBeNull();

      expect((await view(initiator.userId, split.id)).status).toBe('closed');
      expect((await row(split.id)).closedAt).not.toBeNull();
    } finally {
      await queue.resume();
    }
    expect(await completionNotifications(initiator.userId)).toHaveLength(0);
  });

  it('lets a handler run and a read race without double-recording', async () => {
    const { initiator, participants, split, requestOf } = await seedSplit(2);

    await queue.pause();
    try {
      for (const p of participants) {
        await h.payRequest(p.userId, requestOf(p)).expect(201);
      }
      await settle();
    } finally {
      await queue.resume();
    }
    await Promise.all([
      view(initiator.userId, split.id),
      view(initiator.userId, split.id),
      view(participants[0].userId, split.id),
    ]);

    await waitFor(async () => (await row(split.id)).completedAt !== null);
    await settle();
    expect(await completionNotifications(initiator.userId)).toHaveLength(1);
    expect(completionPushes(initiator.userId)).toHaveLength(1);
  });
});
