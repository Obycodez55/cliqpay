import { randomUUID } from 'crypto';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  SplitBody,
  createBillSplitHelpers,
  createBillSplitTestContext,
} from './support/billsplit-test-context';
import { dataOf } from './support/api-response';
import { BillSplit } from '../../src/modules/billsplit/entities/bill-split.entity';

jest.setTimeout(300_000);

const ROUNDS = 20;

describe('cancelling a bill split racing a share payment', () => {
  let ctx: TransfersTestContext;
  const h = createBillSplitHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createBillSplitTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  describe.each([1, 2])('a split with %i participant(s)', (count) => {
    it('never leaves a request status that disagrees with whether its payment posted', async () => {
      const initiator = await h.seedUser('initiator');
      const payer = await h.seedUser('payer', { balanceMinor: 500_000_000n });
      const others = await Promise.all(
        Array.from({ length: count - 1 }, () => h.seedUser('other')),
      );
      const outcomes = { paid: 0, cancelled: 0 };

      for (let round = 0; round < ROUNDS; round += 1) {
        const split = dataOf<SplitBody>(
          await h
            .createSplit(initiator.userId, {
              total: 20_000 * count,
              participants: [payer, ...others].map((u) => ({
                userId: u.userId,
              })),
            })
            .expect(201),
        );
        const payerRequestId = split.participants.find(
          (p) => p.userId === payer.userId,
        )!.moneyRequestId;
        const reference = `cliqpay-split-race-${randomUUID()}`;

        const [payRes, cancelRes] = await Promise.all([
          h.payRequest(payer.userId, payerRequestId, { reference }),
          h
            .http()
            .post(`/bill-splits/${split.id}/cancel`)
            .set('Authorization', `Bearer ${h.tokenFor(initiator.userId)}`),
        ]);

        const request = await ctx.moneyRequestRepo.findOneByOrFail({
          id: payerRequestId,
        });
        const posted = await ctx.transactionRepo.findOneBy({ reference });
        const stored = await ctx.dataSource
          .getRepository(BillSplit)
          .findOneByOrFail({ id: split.id });

        if (request.status === 'paid') {
          outcomes.paid += 1;
          expect(payRes.status).toBe(201);
          expect(request.transactionId).toBe(posted?.id);
          if (count === 1) {
            expect(cancelRes.status).toBe(409);
            expect(stored.cancelledAt).toBeNull();
          } else {
            expect(cancelRes.status).toBe(201);
            expect(stored.cancelledAt).not.toBeNull();
          }
        } else {
          outcomes.cancelled += 1;
          expect(request.status).toBe('cancelled');
          expect(cancelRes.status).toBe(201);
          expect(payRes.status).toBe(422);
          expect(request.transactionId).toBeNull();
          expect(posted).toBeNull();
          expect(stored.cancelledAt).not.toBeNull();
        }

        for (const other of others) {
          const otherRequest = split.participants.find(
            (p) => p.userId === other.userId,
          )!.moneyRequestId;
          const otherRow = await ctx.moneyRequestRepo.findOneByOrFail({
            id: otherRequest,
          });
          expect(otherRow.status).toBe(
            stored.cancelledAt ? 'cancelled' : 'pending',
          );
        }
      }

      expect(outcomes.paid + outcomes.cancelled).toBe(ROUNDS);
    });
  });
});
