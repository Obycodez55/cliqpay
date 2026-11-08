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
import { waitFor } from './support/social-blocks-test-helpers';

jest.setTimeout(180_000);

const DAY_MS = 24 * 60 * 60 * 1000;
const TIER1_CAP = 30_000_000n;

describe('POST /bill-splits — create', () => {
  let ctx: TransfersTestContext;
  const h = createBillSplitHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createBillSplitTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function rowCounts(initiatorId: string) {
    const [{ splits }] = await ctx.dataSource.query<{ splits: string }[]>(
      `SELECT count(*) AS splits FROM bill_splits WHERE initiator_user_id = $1`,
      [initiatorId],
    );
    return {
      splits: Number(splits),
      requests: await ctx.moneyRequestRepo.countBy({
        requesterUserId: initiatorId,
      }),
    };
  }

  async function seedGroup(size: number): Promise<SplitUser[]> {
    return Promise.all(
      Array.from({ length: size }, (_, i) => h.seedUser(`member${i}`)),
    );
  }

  it('rejects an unauthenticated create', async () => {
    await h.http().post('/bill-splits').send({}).expect(401);
  });

  describe('shares', () => {
    it('divides an equal split among the initiator and participants, leftover kobo to the initiator', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b, c] = await seedGroup(3);

      const res = await h
        .createSplit(initiator.userId, {
          mode: 'equal',
          total: 100_002,
          description: 'Dinner at Nkoyo',
          participants: [
            { userId: a.userId },
            { userId: b.userId },
            { userId: c.userId },
          ],
        })
        .expect(201);
      const split = dataOf<SplitBody>(res);

      expect(split).toMatchObject({
        description: 'Dinner at Nkoyo',
        mode: 'equal',
        total: { amount: '100002', currency: 'NGN' },
        initiatorShare: { amount: '25002', currency: 'NGN' },
        initiator: { userId: initiator.userId },
        status: 'open',
      });
      expect(split.participants.map((p) => p.share.amount)).toEqual([
        '25000',
        '25000',
        '25000',
      ]);
      expect(split.participants.every((p) => p.status === 'pending')).toBe(
        true,
      );
    });

    it('takes an amount per participant in custom mode, the initiator keeping the remainder', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);

      const split = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, {
            mode: 'custom',
            total: 100_000,
            participants: [
              { userId: a.userId, amount: 30_000 },
              { userId: b.userId, amount: 45_000 },
            ],
          })
          .expect(201),
      );

      expect(split.initiatorShare.amount).toBe('25000');
      const byUser = new Map(
        split.participants.map((p) => [p.userId, p.share.amount]),
      );
      expect(byUser.get(a.userId)).toBe('30000');
      expect(byUser.get(b.userId)).toBe('45000');
    });

    it('allows a custom split whose participants cover the whole total', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);

      const split = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, {
            mode: 'custom',
            total: 50_000,
            participants: [
              { userId: a.userId, amount: 30_000 },
              { userId: b.userId, amount: 20_000 },
            ],
          })
          .expect(201),
      );
      expect(split.initiatorShare.amount).toBe('0');
    });

    it('rejects an equal split whose shares fall below the minimum, writing nothing', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);

      const res = await h
        .createSplit(initiator.userId, {
          mode: 'equal',
          total: 29_999,
          participants: [{ userId: a.userId }, { userId: b.userId }],
        })
        .expect(422);

      expect(errorOf(res).code).toBe('BILL_SPLIT_SHARE_TOO_SMALL');
      expect(errorOf(res).message).toMatch(/at least 100\.00/);
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 0,
        requests: 0,
      });
    });

    it('accepts an equal split landing exactly on the minimum', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);

      await h
        .createSplit(initiator.userId, {
          total: 30_000,
          participants: [{ userId: a.userId }, { userId: b.userId }],
        })
        .expect(201);
    });

    it('rejects a custom share below the minimum', async () => {
      const initiator = await h.seedUser('initiator');
      const [a] = await seedGroup(1);

      const res = await h
        .createSplit(initiator.userId, {
          mode: 'custom',
          total: 100_000,
          participants: [{ userId: a.userId, amount: 9_999 }],
        })
        .expect(422);
      expect(errorOf(res).code).toBe('BILL_SPLIT_SHARE_TOO_SMALL');
    });

    it('rejects custom amounts adding up to more than the total', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);

      const res = await h
        .createSplit(initiator.userId, {
          mode: 'custom',
          total: 50_000,
          participants: [
            { userId: a.userId, amount: 30_000 },
            { userId: b.userId, amount: 20_001 },
          ],
        })
        .expect(400);
      expect(errorOf(res).code).toBe('BILL_SPLIT_SHARES_INVALID');
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 0,
        requests: 0,
      });
    });

    it('requires an amount for every participant in custom mode and forbids one in equal mode', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);

      await h
        .createSplit(initiator.userId, {
          mode: 'custom',
          participants: [
            { userId: a.userId, amount: 20_000 },
            { userId: b.userId },
          ],
        })
        .expect(400);
      await h
        .createSplit(initiator.userId, {
          mode: 'equal',
          participants: [
            { userId: a.userId, amount: 20_000 },
            { userId: b.userId },
          ],
        })
        .expect(400);
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 0,
        requests: 0,
      });
    });
  });

  describe('request body', () => {
    it('rejects the initiator among the participants, duplicates, none, and too many', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);

      await h
        .createSplit(initiator.userId, {
          participants: [{ userId: initiator.userId }, { userId: a.userId }],
        })
        .expect(400);
      await h
        .createSplit(initiator.userId, {
          participants: [
            { userId: a.userId },
            { userId: a.userId },
            { userId: b.userId },
          ],
        })
        .expect(400);
      await h.createSplit(initiator.userId, { participants: [] }).expect(400);

      const tooMany = Array.from({ length: 21 }, () => ({
        userId: randomUUID(),
      }));
      const res = await h
        .createSplit(initiator.userId, {
          total: 10_000_000,
          participants: tooMany,
        })
        .expect(400);
      expect(errorOf(res).message).toMatch(/at most 20/);
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 0,
        requests: 0,
      });
    });

    it('accepts exactly 20 participants', async () => {
      const initiator = await h.seedUser('initiator');
      const group = await seedGroup(20);

      const split = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, {
            total: 21 * 10_000,
            participants: group.map((u) => ({ userId: u.userId })),
          })
          .expect(201),
      );
      expect(split.participants).toHaveLength(20);
    });

    it('requires a description of 1 to 140 characters, and a reference', async () => {
      const initiator = await h.seedUser('initiator');
      const [a] = await seedGroup(1);
      const participants = [{ userId: a.userId }];

      await h
        .createSplit(initiator.userId, { participants, description: '' })
        .expect(400);
      await h
        .createSplit(initiator.userId, { participants, description: '   ' })
        .expect(400);
      await h
        .createSplit(initiator.userId, {
          participants,
          description: 'x'.repeat(141),
        })
        .expect(400);
      await h
        .createSplit(initiator.userId, {
          participants,
          description: 'x'.repeat(140),
        })
        .expect(201);
      await h
        .createSplit(initiator.userId, { participants, reference: undefined })
        .expect(400);
    });

    it('rejects a non-positive or non-integer total and an unknown mode', async () => {
      const initiator = await h.seedUser('initiator');
      const [a] = await seedGroup(1);
      const participants = [{ userId: a.userId }];

      await h
        .createSplit(initiator.userId, { participants, total: 0 })
        .expect(400);
      await h
        .createSplit(initiator.userId, { participants, total: 10.5 })
        .expect(400);
      await h
        .createSplit(initiator.userId, { participants, mode: 'weighted' })
        .expect(400);
    });

    it('rejects a participant who does not exist, writing nothing', async () => {
      const initiator = await h.seedUser('initiator');
      const [a] = await seedGroup(1);

      await h
        .createSplit(initiator.userId, {
          participants: [{ userId: a.userId }, { userId: randomUUID() }],
        })
        .expect(404);
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 0,
        requests: 0,
      });
    });
  });

  describe('requests', () => {
    it('writes one group-share request per participant, all with the split description as note and one shared expiry', async () => {
      const initiator = await h.seedUser('initiator');
      const group = await seedGroup(3);
      const before = Date.now();

      const split = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, {
            description: 'Airbnb in Lekki',
            participants: group.map((u) => ({ userId: u.userId })),
          })
          .expect(201),
      );

      const requests = await ctx.moneyRequestRepo.findBy({
        requesterUserId: initiator.userId,
      });
      expect(requests).toHaveLength(3);
      expect(new Set(requests.map((r) => r.expiresAt.getTime())).size).toBe(1);
      expect(requests.every((r) => r.kind === 'group_share')).toBe(true);
      expect(requests.every((r) => r.note === 'Airbnb in Lekki')).toBe(true);
      expect(requests.every((r) => r.status === 'pending')).toBe(true);
      expect(requests.map((r) => r.id).sort()).toEqual(
        split.participants.map((p) => p.moneyRequestId).sort(),
      );

      const [stored] = await ctx.dataSource.query<{ expires_at: Date }[]>(
        `SELECT expires_at FROM bill_splits WHERE id = $1`,
        [split.id],
      );
      expect(stored.expires_at.getTime()).toBe(requests[0].expiresAt.getTime());
      expect(stored.expires_at.getTime()).toBeGreaterThanOrEqual(
        before + ctx.config.moneyRequests.expiryDays * DAY_MS,
      );
      expect(split.expiresAt).toBe(stored.expires_at.toISOString());
    });

    it('stores the split and participant rows linked to the requests, with no FK to money requests', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);
      const split = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, {
            participants: [{ userId: a.userId }, { userId: b.userId }],
          })
          .expect(201),
      );

      const participants = await ctx.dataSource.query<
        { user_id: string; amount: string; money_request_id: string }[]
      >(
        `SELECT user_id, amount, money_request_id FROM bill_split_participants WHERE bill_split_id = $1`,
        [split.id],
      );
      expect(participants).toHaveLength(2);
      for (const row of participants) {
        const request = await ctx.moneyRequestRepo.findOneByOrFail({
          id: row.money_request_id,
        });
        expect(request.payerUserId).toBe(row.user_id);
        expect(request.amount.toString()).toBe(row.amount);
      }

      const fks = await ctx.dataSource.query<{ conname: string }[]>(
        `SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid = 'bill_split_participants'::regclass`,
      );
      expect(fks.map((f) => f.conname)).toEqual([
        'FK_bill_split_participants_bill_split_id',
      ]);
    });

    it('lets each participant see the request as incoming in the others bucket when they do not follow the initiator', async () => {
      const initiator = await h.seedUser('initiator');
      const [a] = await seedGroup(1);
      await h
        .createSplit(initiator.userId, {
          total: 20_000,
          participants: [{ userId: a.userId }],
        })
        .expect(201);

      const res = await h
        .http()
        .get('/money-requests/incoming?bucket=others')
        .set('Authorization', `Bearer ${h.tokenFor(a.userId)}`)
        .expect(200);
      const { items } = dataOf<{
        items: { counterparty: { userId: string } }[];
      }>(res);
      expect(items.map((i) => i.counterparty.userId)).toEqual([
        initiator.userId,
      ]);
    });
  });

  describe('atomicity', () => {
    it('fails the whole split when one participant is at the pair cap, naming them and writing nothing', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b, c] = await seedGroup(3);
      for (let i = 0; i < 3; i++) {
        await h
          .http()
          .post('/money-requests')
          .set('Authorization', `Bearer ${h.tokenFor(initiator.userId)}`)
          .send({ payerUserId: b.userId, amount: 10_000 })
          .expect(201);
      }

      const res = await h
        .createSplit(initiator.userId, {
          participants: [
            { userId: a.userId },
            { userId: b.userId },
            { userId: c.userId },
          ],
        })
        .expect(422);

      expect(errorOf(res).code).toBe('MONEY_REQUEST_PAIR_CAP_EXCEEDED');
      expect(errorOf(res).message).toContain(b.username);
      expect(errorOf(res).message).not.toContain(a.username);
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 0,
        requests: 3,
      });
      expect(
        await ctx.moneyRequestRepo.countBy({ payerUserId: a.userId }),
      ).toBe(0);
    });

    it('counts split requests toward the pair cap, but not expired ones', async () => {
      const initiator = await h.seedUser('initiator');
      const [a] = await seedGroup(1);
      for (let i = 0; i < 3; i++) {
        await h
          .createSplit(initiator.userId, {
            total: 20_000,
            participants: [{ userId: a.userId }],
          })
          .expect(201);
      }
      const fourth = await h
        .createSplit(initiator.userId, {
          total: 20_000,
          participants: [{ userId: a.userId }],
        })
        .expect(422);
      expect(errorOf(fourth).code).toBe('MONEY_REQUEST_PAIR_CAP_EXCEEDED');

      await ctx.moneyRequestRepo.update(
        { requesterUserId: initiator.userId },
        { expiresAt: new Date(Date.now() - 60_000) },
      );
      await h
        .createSplit(initiator.userId, {
          total: 20_000,
          participants: [{ userId: a.userId }],
        })
        .expect(201);
    });

    it.each([
      ['the initiator blocked the participant', 'initiator'],
      ['the participant blocked the initiator', 'participant'],
    ])(
      'rejects a blocked participant with a generic error and writes nothing when %s',
      async (_name, blocker) => {
        const initiator = await h.seedUser('initiator');
        const [a, blocked] = await seedGroup(2);
        if (blocker === 'initiator') {
          await h
            .http()
            .put(`/social/blocks/${blocked.userId}`)
            .set('Authorization', `Bearer ${h.tokenFor(initiator.userId)}`)
            .expect(200);
        } else {
          await h
            .http()
            .put(`/social/blocks/${initiator.userId}`)
            .set('Authorization', `Bearer ${h.tokenFor(blocked.userId)}`)
            .expect(200);
        }

        const res = await h
          .createSplit(initiator.userId, {
            participants: [{ userId: a.userId }, { userId: blocked.userId }],
          })
          .expect(422);

        expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
        expect(JSON.stringify(res.body)).not.toMatch(/block/i);
        expect(JSON.stringify(res.body)).not.toContain(blocked.username);
        expect(await rowCounts(initiator.userId)).toEqual({
          splits: 0,
          requests: 0,
        });
      },
    );

    it('lets two participants who blocked each other share a split', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);
      await h
        .http()
        .put(`/social/blocks/${b.userId}`)
        .set('Authorization', `Bearer ${h.tokenFor(a.userId)}`)
        .expect(200);

      const split = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, {
            participants: [{ userId: a.userId }, { userId: b.userId }],
          })
          .expect(201),
      );
      expect(split.participants).toHaveLength(2);
    });
  });

  describe('initiator receive headroom', () => {
    it('checks the sum of the requested shares once, not each share', async () => {
      const initiator = await h.seedUser('headroom', {
        kycTier: 'tier1',
        balanceMinor: TIER1_CAP - 100_000n,
      });
      const [a, b] = await seedGroup(2);

      const over = await h
        .createSplit(initiator.userId, {
          mode: 'custom',
          total: 200_000,
          participants: [
            { userId: a.userId, amount: 50_001 },
            { userId: b.userId, amount: 50_000 },
          ],
        })
        .expect(422);
      expect(JSON.stringify(over.body)).toContain('balance limit');
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 0,
        requests: 0,
      });

      await h
        .createSplit(initiator.userId, {
          mode: 'custom',
          total: 200_000,
          participants: [
            { userId: a.userId, amount: 50_000 },
            { userId: b.userId, amount: 50_000 },
          ],
        })
        .expect(201);
    });

    it('asks an unverified initiator to verify, writing nothing', async () => {
      const initiator = await h.seedUser('tier0', { kycTier: 'tier0' });
      const [a] = await seedGroup(1);

      const res = await h
        .createSplit(initiator.userId, { participants: [{ userId: a.userId }] })
        .expect(422);
      expect(JSON.stringify(res.body)).toContain('before requesting money');
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 0,
        requests: 0,
      });
    });
  });

  describe('reference idempotency', () => {
    it('returns the original split for a replay with the same contents, creating nothing more', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);
      const body = {
        reference: `replay-${randomUUID()}`,
        description: 'Brunch',
        total: 80_000,
        participants: [{ userId: a.userId }, { userId: b.userId }],
      };

      const first = dataOf<SplitBody>(
        await h.createSplit(initiator.userId, body).expect(201),
      );
      const replay = dataOf<SplitBody>(
        await h
          .createSplit(initiator.userId, {
            ...body,
            participants: [{ userId: b.userId }, { userId: a.userId }],
          })
          .expect(201),
      );

      expect(replay.id).toBe(first.id);
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 1,
        requests: 2,
      });
    });

    it('returns 409 for the same reference with different contents', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);
      const body = {
        reference: `conflict-${randomUUID()}`,
        description: 'Brunch',
        total: 80_000,
        participants: [{ userId: a.userId }],
      };
      await h.createSplit(initiator.userId, body).expect(201);

      for (const change of [
        { total: 90_000 },
        { description: 'Lunch' },
        { participants: [{ userId: b.userId }] },
        { participants: [{ userId: a.userId }, { userId: b.userId }] },
        {
          mode: 'custom',
          participants: [{ userId: a.userId, amount: 40_000 }],
        },
      ]) {
        const res = await h
          .createSplit(initiator.userId, { ...body, ...change })
          .expect(409);
        expect(errorOf(res).code).toBe('BILL_SPLIT_REFERENCE_REUSED');
      }
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 1,
        requests: 1,
      });
    });

    it('scopes a reference to its initiator', async () => {
      const first = await h.seedUser('initiator');
      const second = await h.seedUser('initiator');
      const [a] = await seedGroup(1);
      const reference = `shared-${randomUUID()}`;

      const one = dataOf<SplitBody>(
        await h
          .createSplit(first.userId, {
            reference,
            participants: [{ userId: a.userId }],
          })
          .expect(201),
      );
      const two = dataOf<SplitBody>(
        await h
          .createSplit(second.userId, {
            reference,
            participants: [{ userId: a.userId }],
          })
          .expect(201),
      );
      expect(two.id).not.toBe(one.id);
    });

    it('creates one split when the same reference is sent concurrently', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);
      const body = {
        reference: `race-${randomUUID()}`,
        participants: [{ userId: a.userId }, { userId: b.userId }],
      };

      const responses = await Promise.all(
        Array.from({ length: 4 }, () => h.createSplit(initiator.userId, body)),
      );

      expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(new Set(responses.map((r) => dataOf<SplitBody>(r).id)).size).toBe(
        1,
      );
      expect(await rowCounts(initiator.userId)).toEqual({
        splits: 1,
        requests: 2,
      });
    });
  });

  describe('events', () => {
    it('notifies each participant once, after commit', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);
      const body = {
        reference: `events-${randomUUID()}`,
        participants: [{ userId: a.userId }, { userId: b.userId }],
      };

      const split = dataOf<SplitBody>(
        await h.createSplit(initiator.userId, body).expect(201),
      );
      await h.createSplit(initiator.userId, body).expect(201);

      await waitFor(async () => {
        const rows = await ctx.notificationRepo.findBy({
          type: 'money_request_created',
        });
        return split.participants.every((p) =>
          rows.some((r) => r.dedupeKey === p.moneyRequestId),
        );
      });
      for (const participant of split.participants) {
        const rows = await ctx.notificationRepo.findBy({
          userId: participant.userId,
          type: 'money_request_created',
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].dedupeKey).toBe(participant.moneyRequestId);
      }
    });

    it('publishes nothing when the split rolls back', async () => {
      const initiator = await h.seedUser('initiator');
      const [a, b] = await seedGroup(2);
      for (let i = 0; i < 3; i++) {
        await h
          .http()
          .post('/money-requests')
          .set('Authorization', `Bearer ${h.tokenFor(initiator.userId)}`)
          .send({ payerUserId: b.userId, amount: 10_000 })
          .expect(201);
      }

      await h
        .createSplit(initiator.userId, {
          participants: [{ userId: a.userId }, { userId: b.userId }],
        })
        .expect(422);

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(
        await ctx.notificationRepo.countBy({
          userId: a.userId,
          type: 'money_request_created',
        }),
      ).toBe(0);
    });
  });
});
