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
import { dataOf, errorOf } from './support/api-response';
import { BillSplit } from '../../src/modules/billsplit/entities/bill-split.entity';
import { BILL_SPLIT_EVENTS_QUEUE } from '../../src/modules/billsplit/internal/bill-split-events.queue';

jest.setTimeout(180_000);

const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

interface ListItem extends SplitBody {
  moneyRequestId: string | null;
  share: { amount: string; currency: string } | null;
}
interface ListBody {
  items: ListItem[];
  nextCursor: string | null;
}

describe('GET /bill-splits', () => {
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

  function list(userId: string, query: string) {
    return h
      .http()
      .get(`/bill-splits?${query}`)
      .set('Authorization', `Bearer ${h.tokenFor(userId)}`);
  }

  async function listed(userId: string, query: string): Promise<ListBody> {
    return dataOf<ListBody>(await list(userId, query).expect(200));
  }

  async function split(
    initiator: SplitUser,
    participants: SplitUser[],
    total = 60_000,
  ) {
    const body = dataOf<SplitBody>(
      await h
        .createSplit(initiator.userId, {
          total,
          participants: participants.map((p) => ({ userId: p.userId })),
        })
        .expect(201),
    );
    const requestOf = (user: SplitUser) =>
      body.participants.find((p) => p.userId === user.userId)!.moneyRequestId;
    return { ...body, requestOf };
  }

  const cancel = (userId: string, splitId: string) =>
    h
      .http()
      .post(`/bill-splits/${splitId}/cancel`)
      .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
      .expect(201);

  it('lists the splits a user created and the splits they are in, with their own request and share', async () => {
    const alice = await h.seedUser('alice');
    const bob = await h.seedUser('bob', { balanceMinor: 50_000_000n });
    const carol = await h.seedUser('carol');
    const dan = await h.seedUser('dan');
    const aliceSplit = await split(alice, [bob, carol], 90_000);
    const danSplit = await split(dan, [bob]);

    const asInitiator = await listed(alice.userId, 'role=initiator');
    expect(asInitiator.items.map((i) => i.id)).toEqual([aliceSplit.id]);
    expect(asInitiator.items[0].moneyRequestId).toBeNull();
    expect(asInitiator.items[0].share).toBeNull();
    expect(asInitiator.items[0].participants).toHaveLength(2);

    const asBob = await listed(bob.userId, 'role=participant');
    expect(asBob.items.map((i) => i.id)).toEqual([danSplit.id, aliceSplit.id]);
    const bobInAlice = asBob.items.find((i) => i.id === aliceSplit.id)!;
    expect(bobInAlice.moneyRequestId).toBe(aliceSplit.requestOf(bob));
    expect(bobInAlice.share).toEqual({ amount: '30000', currency: 'NGN' });

    expect((await listed(bob.userId, 'role=initiator')).items).toEqual([]);
    expect((await listed(alice.userId, 'role=participant')).items).toEqual([]);
  });

  it('carries the same live participant statuses as the view', async () => {
    const alice = await h.seedUser('alice');
    const bob = await h.seedUser('bob', { balanceMinor: 50_000_000n });
    const carol = await h.seedUser('carol');
    const created = await split(alice, [bob, carol]);
    await h.payRequest(bob.userId, created.requestOf(bob)).expect(201);

    const [item] = (await listed(alice.userId, 'role=initiator')).items;
    const viewed = dataOf<SplitBody>(
      await h.getSplit(alice.userId, created.id).expect(200),
    );
    expect(item.participants).toEqual(viewed.participants);
    expect(item.participants.map((p) => p.status).sort()).toEqual([
      'paid',
      'pending',
    ]);
  });

  it('filters on the split’s own state: open, expired, completed, closed, cancelled', async () => {
    const alice = await h.seedUser('alice');
    const payer = await h.seedUser('payer', { balanceMinor: 500_000_000n });
    const payer2 = await h.seedUser('payer', { balanceMinor: 500_000_000n });
    const other = await h.seedUser('other');
    const open = await split(alice, [payer]);
    const expired = await split(alice, [payer]);
    const completed = await split(alice, [payer]);
    const closed = await split(alice, [payer2]);
    const cancelled = await split(alice, [other]);

    await ctx.dataSource.query(
      `UPDATE bill_splits SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expired.id],
    );
    await h.payRequest(payer.userId, completed.requestOf(payer)).expect(201);
    await h
      .http()
      .post(`/money-requests/${closed.requestOf(payer2)}/decline`)
      .set('Authorization', `Bearer ${h.tokenFor(payer2.userId)}`)
      .expect(201);
    await cancel(alice.userId, cancelled.id);

    const stamped = async (id: string) =>
      (await ctx.dataSource.getRepository(BillSplit).findOneByOrFail({ id }))
        .completedAt;
    for (let i = 0; i < 50 && !(await stamped(completed.id)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await settle();

    const ids = async (status: string) =>
      (await listed(alice.userId, `role=initiator&status=${status}`)).items.map(
        (i) => i.id,
      );
    expect(await ids('open')).toEqual([open.id]);
    expect(await ids('expired')).toEqual([expired.id]);
    expect(await ids('completed')).toEqual([completed.id]);
    expect(await ids('closed')).toEqual([closed.id]);
    expect(await ids('cancelled')).toEqual([cancelled.id]);
    expect((await listed(alice.userId, 'role=initiator')).items).toHaveLength(
      5,
    );
  });

  it('files a split whose outcome event was lost under its old status until a read repairs it', async () => {
    const alice = await h.seedUser('alice');
    const payer = await h.seedUser('payer', { balanceMinor: 50_000_000n });
    await queue.pause();
    let created: Awaited<ReturnType<typeof split>>;
    try {
      created = await split(alice, [payer]);
      await h.payRequest(payer.userId, created.requestOf(payer)).expect(201);
      await settle();

      expect(
        (await listed(alice.userId, 'role=initiator&status=completed')).items,
      ).toEqual([]);
      const [item] = (await listed(alice.userId, 'role=initiator&status=open'))
        .items;
      expect(item.id).toBe(created.id);
      expect(item.status).toBe('completed');
    } finally {
      await queue.resume();
    }
    await settle();

    expect(
      (await listed(alice.userId, 'role=initiator&status=completed')).items.map(
        (i) => i.id,
      ),
    ).toEqual([created.id]);
    expect(
      (await listed(alice.userId, 'role=initiator&status=open')).items,
    ).toEqual([]);
  });

  it('pages by (created_at, id) without gaps or repeats', async () => {
    const alice = await h.seedUser('alice');
    const bob = await h.seedUser('bob');
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const created = await split(alice, [bob], 30_000);
      made.push(created.id);
      await cancel(alice.userId, created.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ListBody = await listed(
        alice.userId,
        `role=initiator&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual([...made].reverse());

    const bobSeen: string[] = [];
    cursor = null;
    do {
      const page: ListBody = await listed(
        bob.userId,
        `role=participant&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      bobSeen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(bobSeen).toEqual(seen);
  });

  it('defaults to 20 per page, caps limit at 50, and rejects bad queries', async () => {
    const alice = await h.seedUser('alice');
    expect((await listed(alice.userId, 'role=initiator')).items).toEqual([]);

    for (const query of [
      '',
      'role=admin',
      'role=initiator&status=paid',
      'role=initiator&limit=51',
      'role=initiator&limit=0',
      'role=initiator&cursor=garbage',
    ]) {
      const res = await list(alice.userId, query).expect(400);
      expect(errorOf(res)).toBeDefined();
    }
    await list(alice.userId, 'role=initiator&limit=50').expect(200);
  });

  it('requires authentication', async () => {
    await h.http().get('/bill-splits?role=initiator').expect(401);
  });
});
