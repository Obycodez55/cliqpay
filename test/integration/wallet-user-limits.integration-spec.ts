import { AuditEvent } from '../../src/shared/audit/entities/audit-event.entity';
import { UserLimit } from '../../src/modules/kyc/entities/user-limit.entity';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
} from './support/withdrawals-test-context';
import {
  SECURITY_ALERT_SUBJECT,
  createAuthTestHelpers,
  extractSixDigitCode,
  stepUpCodeSubject,
  waitFor,
} from './support/auth-test-helpers';
import {
  HOUR_MS,
  createAccountControlsHelpers,
  money,
} from './support/account-controls-helpers';
import { dataOf } from './support/api-response';

jest.setTimeout(180_000);

const PIN = '4821';

interface LimitBody {
  dailyOutflowLimit: { amount: string; currency: string } | null;
  pendingIncrease: {
    amount: { amount: string; currency: string };
    effectiveAt: string;
  } | null;
}

describe('User-set daily outflow limit', () => {
  let ctx: WithdrawalsTestContext;
  let auth: ReturnType<typeof createAuthTestHelpers>;
  const h = createAccountControlsHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
    auth = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  const seedOwner = () => h.seedOwner(auth, PIN);

  const lower = (userId: string, amount: number, pin = PIN) =>
    h
      .authed(userId, 'post', '/wallet/limits/daily/lower')
      .send({ amount, pin });

  const cancel = (userId: string, pin = PIN) =>
    h.authed(userId, 'post', '/wallet/limits/daily/raise/cancel').send({ pin });

  async function stepUp(userId: string): Promise<{
    challengeId: string;
    code: string;
  }> {
    const res = await h
      .authed(userId, 'post', '/wallet/limits/daily/raise/step-up')
      .send({})
      .expect(201);
    const challengeId = dataOf<{ challengeId: string }>(res).challengeId;
    const code = extractSixDigitCode(
      auth.latestEmailWithSubject(stepUpCodeSubject('raise your daily limit'))
        .text,
    );
    return { challengeId, code };
  }

  async function raise(userId: string, amount: number, status: number) {
    const { challengeId, code } = await stepUp(userId);
    return h
      .authed(userId, 'post', '/wallet/limits/daily/raise')
      .send({ amount, pin: PIN, challengeId, code })
      .expect(status);
  }

  async function recipient() {
    return h.seedUser('limit-to', { balanceMinor: 0n });
  }

  describe('lowering', () => {
    it('takes effect at once, with the PIN, and caps the next send', async () => {
      const owner = await seedOwner();
      const to = await recipient();

      const res = await lower(owner.userId, 1_000_000).expect(200);

      expect(dataOf<LimitBody>(res)).toEqual({
        dailyOutflowLimit: money(1_000_000),
        pendingIncrease: null,
      });
      await expect(
        h.transfer(owner.userId, to.userId, 1_500_000, PIN),
      ).rejects.toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });
      await expect(
        h.transfer(owner.userId, to.userId, 1_000_000, PIN),
      ).resolves.toBeDefined();
    });

    it('rejects a wrong PIN and changes nothing', async () => {
      const owner = await seedOwner();

      await lower(owner.userId, 1_000_000, '0000').expect(401);

      expect(
        await ctx.dataSource
          .getRepository(UserLimit)
          .countBy({ userId: owner.userId }),
      ).toBe(0);
    });

    it('rejects a value that is not lower than the current limit', async () => {
      const owner = await seedOwner();
      await lower(owner.userId, 1_000_000).expect(200);

      const res = await lower(owner.userId, 1_000_000).expect(422);

      expect(JSON.stringify(res.body)).toContain('LIMIT_NOT_LOWER');
    });

    it('is audited', async () => {
      const owner = await seedOwner();
      await lower(owner.userId, 1_000_000).expect(200);

      const events = await ctx.dataSource
        .getRepository(AuditEvent)
        .findBy({ subjectId: owner.userId, action: 'daily_limit_lowered' });
      expect(events).toHaveLength(1);
    });
  });

  describe('raising', () => {
    it('is held for 24 hours, alerts the owner, and then applies', async () => {
      const owner = await seedOwner();
      const to = await recipient();
      await lower(owner.userId, 1_000_000).expect(200);

      const res = await raise(owner.userId, 3_000_000, 200);

      const body = dataOf<LimitBody>(res);
      expect(body.dailyOutflowLimit).toEqual(money(1_000_000));
      expect(body.pendingIncrease?.amount).toEqual(money(3_000_000));
      const effectiveAt = new Date(body.pendingIncrease!.effectiveAt);
      expect(effectiveAt.getTime() - Date.now()).toBeGreaterThan(23 * HOUR_MS);
      expect(effectiveAt.getTime() - Date.now()).toBeLessThanOrEqual(
        24 * HOUR_MS,
      );
      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === owner.email &&
            m.subject === SECURITY_ALERT_SUBJECT &&
            m.text.includes('raise your daily sending limit'),
        ),
      );

      await expect(
        h.transfer(owner.userId, to.userId, 2_000_000, PIN),
      ).rejects.toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });

      await ctx.dataSource
        .getRepository(UserLimit)
        .update(
          { userId: owner.userId },
          { pendingEffectiveAt: new Date(Date.now() - 1000) },
        );

      await expect(
        h.transfer(owner.userId, to.userId, 2_000_000, PIN),
      ).resolves.toBeDefined();
      const events = await ctx.dataSource.getRepository(AuditEvent).findBy({
        subjectId: owner.userId,
        action: 'daily_limit_raise_requested',
      });
      expect(events).toHaveLength(1);
    });

    it('needs a valid step-up code and the PIN', async () => {
      const owner = await seedOwner();
      await lower(owner.userId, 1_000_000).expect(200);
      const { challengeId, code } = await stepUp(owner.userId);

      await h
        .authed(owner.userId, 'post', '/wallet/limits/daily/raise')
        .send({
          amount: 3_000_000,
          pin: PIN,
          challengeId,
          code: code === '000000' ? '111111' : '000000',
        })
        .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));

      const second = await stepUp(owner.userId);
      await h
        .authed(owner.userId, 'post', '/wallet/limits/daily/raise')
        .send({ amount: 3_000_000, pin: '0000', ...second })
        .expect(401);

      const row = await ctx.dataSource
        .getRepository(UserLimit)
        .findOneByOrFail({ userId: owner.userId });
      expect(row.pendingDailyOutflowLimitMinor).toBeNull();
    });

    it('cannot exceed the tier limit', async () => {
      const owner = await seedOwner();

      const res = await raise(owner.userId, 5_000_001, 422);

      expect(JSON.stringify(res.body)).toContain('LIMIT_ABOVE_TIER');
    });

    it('must be higher than the current limit', async () => {
      const owner = await seedOwner();
      await lower(owner.userId, 1_000_000).expect(200);

      const res = await raise(owner.userId, 1_000_000, 422);

      expect(JSON.stringify(res.body)).toContain('LIMIT_NOT_HIGHER');
    });
  });

  describe('cancelling a pending raise', () => {
    it('removes it with the PIN, leaving the current limit', async () => {
      const owner = await seedOwner();
      const to = await recipient();
      await lower(owner.userId, 1_000_000).expect(200);
      await raise(owner.userId, 3_000_000, 200);

      const res = await cancel(owner.userId).expect(200);

      expect(dataOf<LimitBody>(res)).toEqual({
        dailyOutflowLimit: money(1_000_000),
        pendingIncrease: null,
      });
      expect((await h.limits(owner.userId)).pendingIncrease).toBeNull();
      await ctx.dataSource
        .getRepository(UserLimit)
        .update({ userId: owner.userId }, { pendingEffectiveAt: null });
      await expect(
        h.transfer(owner.userId, to.userId, 2_000_000, PIN),
      ).rejects.toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });
    });

    it('needs the PIN', async () => {
      const owner = await seedOwner();
      await lower(owner.userId, 1_000_000).expect(200);
      await raise(owner.userId, 3_000_000, 200);

      await cancel(owner.userId, '0000').expect(401);

      expect((await h.limits(owner.userId)).pendingIncrease).not.toBeNull();
    });

    it('is a 404 when nothing is pending', async () => {
      const owner = await seedOwner();

      const res = await cancel(owner.userId).expect(404);

      expect(JSON.stringify(res.body)).toContain('NO_PENDING_LIMIT_INCREASE');
    });

    it('happens when the limit is lowered again', async () => {
      const owner = await seedOwner();
      await lower(owner.userId, 2_000_000).expect(200);
      await raise(owner.userId, 4_000_000, 200);

      await lower(owner.userId, 1_000_000).expect(200);

      const limits = await h.limits(owner.userId);
      expect(limits.pendingIncrease).toBeNull();
      expect(limits.userLimit).toEqual(money(1_000_000));
    });
  });
});
