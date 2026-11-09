import { randomUUID } from 'crypto';
import {
  TransfersTestContext,
  destroyTransfersTestContext,
} from './support/transfers-test-context';
import {
  ScheduleBody,
  createSchedulingHelpers,
  createSchedulingTestContext,
  tomorrow,
} from './support/scheduling-test-context';
import { dataOf, errorOf } from './support/api-response';
import { waitFor } from './support/social-blocks-test-helpers';
import { ScheduledPaymentChange } from '../../src/modules/scheduling/entities/scheduled-payment-change.entity';
import {
  addDays,
  computeDueAt,
  lagosToday,
} from '../../src/modules/scheduling/internal/run-time';
import { addTestRestriction } from './support/restrictions';

jest.setTimeout(180_000);

describe('POST /scheduled-payments', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  it('schedules a payment without checking the balance, at the window start plus a fixed offset', async () => {
    const sender = await h.seedUser('sender');
    const recipient = await h.seedUser('recipient');
    const startDate = addDays(lagosToday(new Date()), 3);

    const res = await h
      .createSchedule(sender.userId, recipient.userId, {
        amount: 250_000,
        startDate,
        note: 'Rent',
        visibility: 'public',
      })
      .expect(201);

    const body = dataOf<ScheduleBody>(res);
    expect(body).toMatchObject({
      target: { type: 'user', userId: recipient.userId },
      amount: { amount: '250000', currency: 'NGN' },
      note: 'Rent',
      visibility: 'public',
      status: 'active',
      nextRunDate: startDate,
    });

    const row = await h.scheduleRepo().findOneByOrFail({ id: body.id });
    expect(row.runOffsetMinutes).toBeGreaterThanOrEqual(0);
    expect(row.runOffsetMinutes).toBeLessThan(240);
    expect(row.nextRunNumber).toBe(1);
    expect(row.nextRunAt).toEqual(
      computeDueAt(startDate, '06:00', row.runOffsetMinutes),
    );
    expect(body.nextRunAt).toBe(row.nextRunAt!.toISOString());
    // 06:00 in Lagos is 05:00 UTC
    expect(
      row.nextRunAt!.getTime() - Date.parse(`${startDate}T05:00:00Z`),
    ).toBe(row.runOffsetMinutes * 60_000);
  });

  it('records a created change and notifies the sender by email and in-app', async () => {
    const sender = await h.seedUser('sender');
    const recipient = await h.seedUser('recipient');

    const id = dataOf<ScheduleBody>(
      await h.createSchedule(sender.userId, recipient.userId).expect(201),
    ).id;

    const changes = await ctx.dataSource
      .getRepository(ScheduledPaymentChange)
      .findBy({ scheduledPaymentId: id });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'created', actor: 'user' });

    await waitFor(async () =>
      Boolean(
        await ctx.notificationRepo.findOneBy({
          userId: sender.userId,
          type: 'scheduled_payment_created',
        }),
      ),
    );
    await waitFor(() =>
      ctx.emailAdapter.sent.some(
        (m) => m.to === sender.email && /scheduled/i.test(m.subject),
      ),
    );
    const inApp = await ctx.notificationRepo.findOneByOrFail({
      userId: sender.userId,
      type: 'scheduled_payment_created',
    });
    expect(inApp.dedupeKey).toBe(id);
    expect(
      await ctx.notificationRepo.countBy({
        userId: recipient.userId,
        type: 'scheduled_payment_created',
      }),
    ).toBe(0);
  });

  describe('start date', () => {
    it.each([
      ['today', () => lagosToday(new Date())],
      ['in the past', () => addDays(lagosToday(new Date()), -1)],
      ['more than a year ahead', () => addDays(lagosToday(new Date()), 367)],
      ['not a real date', () => '2026-02-30'],
      ['not a date', () => 'next friday'],
    ])('rejects a date %s with 400', async (_name, date) => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');

      await h
        .createSchedule(sender.userId, recipient.userId, { startDate: date() })
        .expect(400);
    });

    it('accepts tomorrow and a year ahead', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');

      await h
        .createSchedule(sender.userId, recipient.userId, {
          startDate: tomorrow(),
        })
        .expect(201);
      const [year, rest] = [
        Number(lagosToday(new Date()).slice(0, 4)),
        lagosToday(new Date()).slice(4),
      ];
      const yearAhead =
        rest === '-02-29' ? `${year + 1}-02-28` : `${year + 1}${rest}`;
      await h
        .createSchedule(sender.userId, recipient.userId, {
          startDate: yearAhead,
        })
        .expect(201);
    });
  });

  describe('body validation', () => {
    it.each([
      ['no visibility', { visibility: undefined }],
      ['an unknown visibility', { visibility: 'friends' }],
      ['an empty-after-trim note is dropped, not rejected', null],
      ['a note over 500 characters', { note: 'x'.repeat(501) }],
      ['a zero amount', { amount: 0 }],
      ['a fractional amount', { amount: 100.5 }],
      [
        'a non-user target',
        { target: { type: 'bank_account', userId: randomUUID() } },
      ],
      ['a 3-digit pin', { pin: '123' }],
      ['a reserved sched_ reference', { reference: 'sched_anything' }],
    ])('handles %s', async (name, override) => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');

      if (override === null) {
        await h
          .createSchedule(sender.userId, recipient.userId, { note: '   ' })
          .expect(201);
        return;
      }
      await h
        .createSchedule(sender.userId, recipient.userId, override)
        .expect(400);
    });
  });

  describe('sender checks', () => {
    it('rejects an unverified sender (tier 0) with a KYC error', async () => {
      const sender = await h.seedUser('sender', { kycTier: 'tier0' });
      const recipient = await h.seedUser('recipient');

      const res = await h.createSchedule(sender.userId, recipient.userId);
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('KYC_VERIFICATION_REQUIRED');
    });

    it('rejects an unverified email with 403', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      await ctx.userRepo.update(
        { id: sender.userId },
        { emailVerifiedAt: null },
      );

      const res = await h
        .createSchedule(sender.userId, recipient.userId)
        .expect(403);
      expect(errorOf(res).code).toBe('SENDER_EMAIL_NOT_VERIFIED');
    });

    it('rejects a frozen sender with 403', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      await addTestRestriction(ctx.dataSource, sender.userId);

      const res = await h
        .createSchedule(sender.userId, recipient.userId)
        .expect(403);
      expect(errorOf(res).code).toBe('SENDER_ACCOUNT_FROZEN');
    });

    it('rejects an amount below the transfer minimum', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');

      const res = await h
        .createSchedule(sender.userId, recipient.userId, { amount: 9_999 })
        .expect(422);
      expect(errorOf(res).code).toBe('TRANSFER_AMOUNT_TOO_SMALL');
    });

    it("rejects an amount above the sender's daily limit, and accepts exactly the limit", async () => {
      const sender = await h.seedUser('sender', { kycTier: 'tier1' });
      const recipient = await h.seedUser('recipient');

      const over = await h
        .createSchedule(sender.userId, recipient.userId, {
          amount: 5_000_001,
        })
        .expect(422);
      expect(errorOf(over).code).toBe('SCHEDULE_AMOUNT_EXCEEDS_DAILY_LIMIT');

      await h
        .createSchedule(sender.userId, recipient.userId, { amount: 5_000_000 })
        .expect(201);
    });
  });

  describe('recipient checks', () => {
    it('rejects scheduling to yourself', async () => {
      const sender = await h.seedUser('sender');

      const res = await h
        .createSchedule(sender.userId, sender.userId)
        .expect(422);
      expect(errorOf(res).code).toBe('SELF_TRANSFER_NOT_ALLOWED');
    });

    it('rejects a recipient with no wallet', async () => {
      const sender = await h.seedUser('sender');

      await h.createSchedule(sender.userId, randomUUID()).expect(404);
    });

    it.each([
      ['the sender blocked the recipient', 0],
      ['the recipient blocked the sender', 1],
    ] as const)(
      'rejects a pair where %s, without saying why',
      async (_name, blockerIndex) => {
        const users = [
          await h.seedUser('sender'),
          await h.seedUser('recipient'),
        ];
        await h
          .http()
          .put(`/social/blocks/${users[1 - blockerIndex].userId}`)
          .set(
            'Authorization',
            `Bearer ${h.tokenFor(users[blockerIndex].userId)}`,
          )
          .expect(200);

        const res = await h
          .createSchedule(users[0].userId, users[1].userId)
          .expect(422);
        expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
        expect(JSON.stringify(res.body)).not.toMatch(/block/i);
      },
    );

    it('rejects a recipient who could not receive the amount, without revealing their tier', async () => {
      const sender = await h.seedUser('sender');
      const unverified = await h.seedUser('recipient', { kycTier: 'tier0' });

      const res = await h
        .createSchedule(sender.userId, unverified.userId)
        .expect(422);
      expect(errorOf(res).code).toBe('RECIPIENT_UNABLE_TO_RECEIVE');
      expect(JSON.stringify(res.body)).not.toMatch(/tier|kyc|bvn/i);
    });
  });

  describe('PIN', () => {
    it('rejects a wrong PIN with 401 and creates nothing', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');

      await h
        .createSchedule(sender.userId, recipient.userId, { pin: '0000' })
        .expect(401);
      expect(await h.scheduleRepo().countBy({ userId: sender.userId })).toBe(0);
    });

    it('shares its lockout counter with a live send', async () => {
      const sender = await h.seedUser('sender', { balanceMinor: 5_000_000n });
      const recipient = await h.seedUser('recipient');

      for (let i = 0; i < 3; i++) {
        await h
          .createSchedule(sender.userId, recipient.userId, { pin: '0000' })
          .expect(401);
      }

      await h
        .http()
        .post('/transfers')
        .set('Authorization', `Bearer ${h.tokenFor(sender.userId)}`)
        .send({
          recipientUserId: recipient.userId,
          amount: 100_000,
          reference: `live-after-lock-${randomUUID()}`,
          visibility: 'private',
          pin: '1234',
        })
        .expect(423);
      await h.createSchedule(sender.userId, recipient.userId).expect(423);
    });
  });

  describe('idempotency', () => {
    it('returns the original schedule for the same reference and contents', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      const reference = `sched-idem-${randomUUID()}`;
      const body = { reference, note: 'Rent', visibility: 'public' };

      const first = dataOf<ScheduleBody>(
        await h
          .createSchedule(sender.userId, recipient.userId, body)
          .expect(201),
      );
      const second = dataOf<ScheduleBody>(
        await h
          .createSchedule(sender.userId, recipient.userId, body)
          .expect(201),
      );

      expect(second.id).toBe(first.id);
      expect(second.nextRunAt).toBe(first.nextRunAt);
      expect(await h.scheduleRepo().countBy({ userId: sender.userId })).toBe(1);
    });

    it('replays without asking for the PIN again', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      const reference = `sched-idem-${randomUUID()}`;
      await h
        .createSchedule(sender.userId, recipient.userId, { reference })
        .expect(201);

      await h
        .createSchedule(sender.userId, recipient.userId, {
          reference,
          pin: '0000',
        })
        .expect(201);
    });

    it.each([
      ['amount', { amount: 200_000 }],
      ['start date', { startDate: addDays(tomorrow(), 1) }],
      ['note', { note: 'Different' }],
      ['visibility', { visibility: 'public' }],
    ])('returns 409 when the %s differs', async (_name, change) => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      const reference = `sched-idem-${randomUUID()}`;
      await h
        .createSchedule(sender.userId, recipient.userId, { reference })
        .expect(201);

      const res = await h
        .createSchedule(sender.userId, recipient.userId, {
          reference,
          ...change,
        })
        .expect(409);
      expect(errorOf(res).code).toBe('SCHEDULE_REFERENCE_REUSED');
    });

    it('returns 409 when the recipient differs', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      const other = await h.seedUser('other');
      const reference = `sched-idem-${randomUUID()}`;
      await h
        .createSchedule(sender.userId, recipient.userId, { reference })
        .expect(201);

      await h
        .createSchedule(sender.userId, other.userId, { reference })
        .expect(409);
    });

    it('lets two users use the same reference', async () => {
      const a = await h.seedUser('sender');
      const b = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      const reference = `sched-shared-${randomUUID()}`;

      await h
        .createSchedule(a.userId, recipient.userId, { reference })
        .expect(201);
      await h
        .createSchedule(b.userId, recipient.userId, { reference })
        .expect(201);
    });

    it('creates exactly one schedule when the same request is sent concurrently', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      const reference = `sched-race-${randomUUID()}`;

      const responses = await Promise.all(
        [1, 2, 3].map(() =>
          h.createSchedule(sender.userId, recipient.userId, { reference }),
        ),
      );

      expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(
        new Set(responses.map((r) => dataOf<ScheduleBody>(r).id)).size,
      ).toBe(1);
      expect(await h.scheduleRepo().countBy({ userId: sender.userId })).toBe(1);
    });
  });

  describe('active schedule limit', () => {
    const original = () => ctx.config.scheduledPayments.maxActive;
    let restore: number;

    beforeEach(() => {
      restore = original();
      ctx.config.scheduledPayments.maxActive = 2;
    });

    afterEach(() => {
      ctx.config.scheduledPayments.maxActive = restore;
    });

    it('refuses a schedule over the limit', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');

      await h.createSchedule(sender.userId, recipient.userId).expect(201);
      await h.createSchedule(sender.userId, recipient.userId).expect(201);
      const res = await h
        .createSchedule(sender.userId, recipient.userId)
        .expect(422);
      expect(errorOf(res).code).toBe('SCHEDULE_LIMIT_REACHED');
    });

    it('frees a slot when a schedule is cancelled', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      const first = dataOf<ScheduleBody>(
        await h.createSchedule(sender.userId, recipient.userId).expect(201),
      );
      await h.createSchedule(sender.userId, recipient.userId).expect(201);

      await h.cancelSchedule(sender.userId, first.id).expect(201);

      await h.createSchedule(sender.userId, recipient.userId).expect(201);
    });

    it('holds under concurrent creates', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');

      const responses = await Promise.all(
        [1, 2, 3, 4].map(() =>
          h.createSchedule(sender.userId, recipient.userId),
        ),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
      expect(await h.scheduleRepo().countBy({ userId: sender.userId })).toBe(2);
    });

    it("does not count another user's schedules", async () => {
      const a = await h.seedUser('sender');
      const b = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');
      await h.createSchedule(a.userId, recipient.userId).expect(201);
      await h.createSchedule(a.userId, recipient.userId).expect(201);

      await h.createSchedule(b.userId, recipient.userId).expect(201);
    });
  });
});
