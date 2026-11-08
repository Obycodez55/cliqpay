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

jest.setTimeout(180_000);

describe('Scheduled payments to bank accounts: create, view and edit', () => {
  let ctx: TransfersTestContext;
  const h = createSchedulingHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createSchedulingTestContext();
  });

  afterAll(async () => {
    await destroyTransfersTestContext(ctx);
  });

  async function seedSender(options: { tier?: 'tier1' | 'tier0' } = {}) {
    const sender = await h.seedUser('sender', { kycTier: options.tier });
    const bank = await h.seedBank(sender.userId, {
      bankName: 'GTBank',
      accountNumber: '0123454821',
    });
    return { sender, bank };
  }

  it('creates a bank schedule with no visibility, showing the target and the per-run fees', async () => {
    const { sender, bank } = await seedSender();

    const res = await h.createBankSchedule(sender.userId, bank.id).expect(201);
    const body = dataOf<ScheduleBody>(res);

    expect(body).toMatchObject({
      target: { type: 'bank_account', bankAccountId: bank.id },
      visibility: null,
      status: 'active',
      fees: {
        platform: { amount: '0', currency: 'NGN' },
        provider: { amount: '3000', currency: 'NGN' },
      },
    });
    expect(body.target.userId).toBeUndefined();
    const row = await h.scheduleRepo().findOneByOrFail({ id: body.id });
    expect(row).toMatchObject({
      targetType: 'bank_account',
      bankAccountId: bank.id,
      recipientUserId: null,
      visibility: null,
    });
    const viewed = dataOf<ScheduleBody>(
      await h.getSchedule(sender.userId, body.id).expect(200),
    );
    expect(viewed.fees).toEqual(body.fees);
    const listed = dataOf<{ items: ScheduleBody[] }>(
      await h.listSchedules(sender.userId).expect(200),
    );
    expect(listed.items[0]).toMatchObject({
      target: { type: 'bank_account', bankAccountId: bank.id },
      fees: body.fees,
    });
  });

  it('does not show fees on a user schedule', async () => {
    const sender = await h.seedUser('sender');
    const recipient = await h.seedUser('recipient');

    const body = dataOf<ScheduleBody>(
      await h.createSchedule(sender.userId, recipient.userId).expect(201),
    );

    expect(body.fees).toBeNull();
    expect(body.visibility).toBe('private');
  });

  it('notifies the sender with the bank name and masked number, never the full number', async () => {
    const { sender, bank } = await seedSender();

    const body = dataOf<ScheduleBody>(
      await h.createBankSchedule(sender.userId, bank.id).expect(201),
    );

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
    expect(inApp.dedupeKey).toBe(body.id);
    expect(inApp.body).toContain('GTBank ••4821');
    expect(inApp.body).not.toContain('0123454821');
    const email = ctx.emailAdapter.sent.find(
      (m) => m.to === sender.email && /scheduled/i.test(m.subject),
    )!;
    expect(JSON.stringify(email)).toContain('GTBank ••4821');
    expect(JSON.stringify(email)).not.toContain('0123454821');
  });

  describe('validation', () => {
    it('forbids visibility on a bank target with 400, creating nothing', async () => {
      const { sender, bank } = await seedSender();

      const res = await h
        .createBankSchedule(sender.userId, bank.id, { visibility: 'private' })
        .expect(400);

      expect(errorOf(res).code).toBe('SCHEDULE_TARGET_INVALID');
      expect(await h.scheduleRepo().countBy({ userId: sender.userId })).toBe(0);
    });

    it('still requires visibility on a user target', async () => {
      const sender = await h.seedUser('sender');
      const recipient = await h.seedUser('recipient');

      const res = await h
        .createSchedule(sender.userId, recipient.userId, {
          visibility: undefined,
        })
        .expect(400);

      expect(errorOf(res).code).toBe('SCHEDULE_TARGET_INVALID');
    });

    it('rejects a target carrying the other type’s id with 400', async () => {
      const { sender, bank } = await seedSender();

      await h
        .createBankSchedule(sender.userId, bank.id, {
          target: {
            type: 'bank_account',
            bankAccountId: bank.id,
            userId: sender.userId,
          },
        })
        .expect(400);
    });

    it('rejects a bank account that belongs to someone else with 404', async () => {
      const { sender } = await seedSender();
      const other = await h.seedUser('other');
      const foreign = await h.seedBank(other.userId);

      const res = await h
        .createBankSchedule(sender.userId, foreign.id)
        .expect(404);

      expect(errorOf(res).code).toBe('BANK_ACCOUNT_NOT_FOUND');
      expect(await h.scheduleRepo().countBy({ userId: sender.userId })).toBe(0);
    });

    it('rejects an unknown bank account with 404', async () => {
      const { sender } = await seedSender();

      await h.createBankSchedule(sender.userId, randomUUID()).expect(404);
    });

    it('rejects an amount below the withdrawal minimum', async () => {
      const { sender, bank } = await seedSender();

      const res = await h
        .createBankSchedule(sender.userId, bank.id, { amount: 9_999 })
        .expect(422);

      expect(errorOf(res).code).toBe('WITHDRAWAL_AMOUNT_TOO_SMALL');
      await h
        .createBankSchedule(sender.userId, bank.id, { amount: 10_000 })
        .expect(201);
    });

    it("rejects an amount above the sender's daily limit, and accepts exactly the limit", async () => {
      const { sender, bank } = await seedSender({ tier: 'tier1' });

      const over = await h
        .createBankSchedule(sender.userId, bank.id, { amount: 5_000_001 })
        .expect(422);

      expect(errorOf(over).code).toBe('SCHEDULE_AMOUNT_EXCEEDS_DAILY_LIMIT');
      await h
        .createBankSchedule(sender.userId, bank.id, { amount: 5_000_000 })
        .expect(201);
    });

    it('rejects an unverified tier, an unverified email and a frozen sender', async () => {
      const tier0 = await seedSender({ tier: 'tier0' });
      const res = await h
        .createBankSchedule(tier0.sender.userId, tier0.bank.id)
        .expect(422);
      expect(errorOf(res).code).toBe('KYC_VERIFICATION_REQUIRED');

      const unverified = await seedSender();
      await ctx.userRepo.update(
        { id: unverified.sender.userId },
        { emailVerifiedAt: null },
      );
      const email = await h
        .createBankSchedule(unverified.sender.userId, unverified.bank.id)
        .expect(403);
      expect(errorOf(email).code).toBe('SENDER_EMAIL_NOT_VERIFIED');

      const frozen = await seedSender();
      await ctx.userRepo.update(
        { id: frozen.sender.userId },
        { isFrozen: true },
      );
      const frozenRes = await h
        .createBankSchedule(frozen.sender.userId, frozen.bank.id)
        .expect(403);
      expect(errorOf(frozenRes).code).toBe('SENDER_ACCOUNT_FROZEN');
    });

    it('asks for the PIN, and nothing else', async () => {
      const { sender, bank } = await seedSender();

      await h
        .createBankSchedule(sender.userId, bank.id, { pin: '9999' })
        .expect(401);
      await h.createBankSchedule(sender.userId, bank.id).expect(201);
    });

    it('does not check the balance, blocks or the recipient side', async () => {
      const { sender, bank } = await seedSender();

      await h
        .createBankSchedule(sender.userId, bank.id, { amount: 4_000_000 })
        .expect(201);
    });
  });

  describe('idempotency', () => {
    it('replays the same reference and contents, and 409s when the bank account differs', async () => {
      const { sender, bank } = await seedSender();
      const other = await h.seedBank(sender.userId);
      const reference = `bank-ref-${randomUUID()}`;

      const first = dataOf<ScheduleBody>(
        await h
          .createBankSchedule(sender.userId, bank.id, { reference })
          .expect(201),
      );
      const again = dataOf<ScheduleBody>(
        await h
          .createBankSchedule(sender.userId, bank.id, { reference })
          .expect(201),
      );
      const differ = await h
        .createBankSchedule(sender.userId, other.id, { reference })
        .expect(409);

      expect(again.id).toBe(first.id);
      expect(errorOf(differ).code).toBe('SCHEDULE_REFERENCE_REUSED');
      expect(await h.scheduleRepo().countBy({ userId: sender.userId })).toBe(1);
    });

    it('409s when a user-target request reuses a bank schedule’s reference', async () => {
      const { sender, bank } = await seedSender();
      const recipient = await h.seedUser('recipient');
      const reference = `bank-ref-${randomUUID()}`;
      await h
        .createBankSchedule(sender.userId, bank.id, { reference })
        .expect(201);

      await h
        .createSchedule(sender.userId, recipient.userId, { reference })
        .expect(409);
    });
  });

  describe('editing', () => {
    async function seedSchedule() {
      const { sender, bank } = await seedSender();
      const schedule = dataOf<ScheduleBody>(
        await h.createBankSchedule(sender.userId, bank.id).expect(201),
      );
      return { sender, bank, schedule };
    }

    const patch = (userId: string, id: string, body: Record<string, unknown>) =>
      h
        .http()
        .patch(`/scheduled-payments/${id}`)
        .set('Authorization', `Bearer ${h.tokenFor(userId)}`)
        .send(body);

    it('forbids visibility on a bank schedule with 400', async () => {
      const { sender, schedule } = await seedSchedule();

      const res = await patch(sender.userId, schedule.id, {
        visibility: 'public',
      }).expect(400);

      expect(errorOf(res).code).toBe('SCHEDULE_TARGET_INVALID');
    });

    it('cannot change the payee', async () => {
      const { sender, schedule } = await seedSchedule();
      const other = await h.seedBank(sender.userId);

      await patch(sender.userId, schedule.id, {
        bankAccountId: other.id,
      }).expect(400);
    });

    it('edits a note with no PIN, and the amount with a PIN against the withdrawal minimum', async () => {
      const { sender, schedule } = await seedSchedule();

      await patch(sender.userId, schedule.id, { note: 'Rent' }).expect(200);
      await patch(sender.userId, schedule.id, { amount: 5_000 }).expect(400);
      const tooSmall = await patch(sender.userId, schedule.id, {
        amount: 5_000,
        pin: '1234',
      }).expect(422);
      expect(errorOf(tooSmall).code).toBe('WITHDRAWAL_AMOUNT_TOO_SMALL');
      const edited = dataOf<ScheduleBody>(
        await patch(sender.userId, schedule.id, {
          amount: 250_000,
          pin: '1234',
        }).expect(200),
      );

      expect(edited.amount.amount).toBe('250000');
      expect(edited.target.type).toBe('bank_account');
      const changes = await ctx.dataSource
        .getRepository(ScheduledPaymentChange)
        .findBy({ scheduledPaymentId: schedule.id, kind: 'updated' });
      expect(changes).toHaveLength(2);
    });

    it('labels the bank account in the change notification', async () => {
      const { sender, schedule } = await seedSchedule();

      await patch(sender.userId, schedule.id, {
        amount: 250_000,
        pin: '1234',
      }).expect(200);

      await waitFor(async () =>
        Boolean(
          await ctx.notificationRepo.findOneBy({
            userId: sender.userId,
            type: 'scheduled_payment_updated',
          }),
        ),
      );
      const note = await ctx.notificationRepo.findOneByOrFail({
        userId: sender.userId,
        type: 'scheduled_payment_updated',
      });
      expect(note.body).toContain('GTBank ••4821');
    });
  });

  describe('target CHECK', () => {
    const insert = (columns: string, values: string) =>
      ctx.dataSource.query(
        `INSERT INTO scheduled_payments (user_id, reference, ${columns}, amount, currency, start_date, run_offset_minutes, status)
         VALUES ('${randomUUID()}', 'chk-${randomUUID()}', ${values}, 100000, 'NGN', '${tomorrow()}', 0, 'active')`,
      );

    it.each([
      [
        'a bank target carrying a visibility',
        `target_type, bank_account_id, visibility`,
        `'bank_account', '${randomUUID()}', 'private'`,
      ],
      [
        'a bank target carrying a recipient',
        `target_type, bank_account_id, recipient_user_id`,
        `'bank_account', '${randomUUID()}', '${randomUUID()}'`,
      ],
      ['a bank target with no bank account', `target_type`, `'bank_account'`],
      [
        'a user target carrying a bank account',
        `target_type, recipient_user_id, bank_account_id, visibility`,
        `'user', '${randomUUID()}', '${randomUUID()}', 'private'`,
      ],
      [
        'a user target with no visibility',
        `target_type, recipient_user_id`,
        `'user', '${randomUUID()}'`,
      ],
    ])('rejects %s', async (_name, columns, values) => {
      await expect(insert(columns, values)).rejects.toThrow(
        /CHK_scheduled_payments_target/,
      );
    });
  });
});
