import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';
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
import { BillSplitService } from '../../src/modules/billsplit/billsplit.service';
import { BILL_SPLIT_EVENTS_QUEUE } from '../../src/modules/billsplit/internal/bill-split-events.queue';

jest.setTimeout(240_000);

const SMALL_POOL = 3;
const BURST = 8;

describe('bill split transactions and the connection pool', () => {
  let ctx: TransfersTestContext;
  const h = createBillSplitHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createBillSplitTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  // A transaction that borrows a second connection while holding its own
  // deadlocks once enough run at the same time to hold the whole pool, so a
  // pool smaller than the burst turns any such read into a failed request.
  async function resizePool(max: number): Promise<void> {
    const driver = ctx.dataSource.driver as PostgresDriver;
    Object.assign(driver.options.extra ?? {}, {
      max,
      connectionTimeoutMillis: 5_000,
    });
    await driver.disconnect();
    await driver.connect();
  }

  it('creates, cancels and records outcomes for a burst of splits larger than the pool', async () => {
    const bursts: { initiator: SplitUser; payer: SplitUser }[] = [];
    for (let i = 0; i < BURST; i++) {
      bursts.push({
        initiator: await h.seedUser('initiator'),
        payer: await h.seedUser('payer', { balanceMinor: 50_000_000n }),
      });
    }
    await h.waitForSplitEventsProcessed();
    const queue = ctx.app.get<Queue>(getQueueToken(BILL_SPLIT_EVENTS_QUEUE));
    await queue.pause();

    await resizePool(SMALL_POOL);
    const created = await Promise.all(
      bursts.map(({ initiator, payer }) =>
        h.createSplit(initiator.userId, {
          total: 40_000,
          participants: [{ userId: payer.userId }],
        }),
      ),
    );
    expect(created.map((r) => r.status)).toEqual(Array(BURST).fill(201));
    const splits = created.map((r) => dataOf<SplitBody>(r));

    const direct = await Promise.all(
      bursts.map(({ initiator, payer }) =>
        h
          .http()
          .post('/money-requests')
          .set('Authorization', `Bearer ${h.tokenFor(initiator.userId)}`)
          .send({ payerUserId: payer.userId, amount: 20_000 }),
      ),
    );
    expect(direct.map((r) => r.status)).toEqual(Array(BURST).fill(201));

    const half = BURST / 2;
    const cancelled = await Promise.all(
      splits.slice(0, half).map((split, i) =>
        h
          .http()
          .post(`/bill-splits/${split.id}/cancel`)
          .set(
            'Authorization',
            `Bearer ${h.tokenFor(bursts[i].initiator.userId)}`,
          ),
      ),
    );
    expect(cancelled.map((r) => r.status)).toEqual(Array(half).fill(201));

    await resizePool(10);
    for (let i = half; i < BURST; i++) {
      await h
        .payRequest(
          bursts[i].payer.userId,
          splits[i].participants[0].moneyRequestId,
        )
        .expect(201);
    }
    await resizePool(SMALL_POOL);
    const service = ctx.app.get(BillSplitService);
    const outcomes = await Promise.all(
      splits.slice(half).map((split) => service.recordOutcome(split.id)),
    );
    expect(outcomes).toEqual(Array(half).fill('completed'));

    await resizePool(10);
    await queue.resume();
  });
});
