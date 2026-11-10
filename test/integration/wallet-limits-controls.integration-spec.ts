import { UserLimit } from '../../src/modules/kyc/entities/user-limit.entity';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
} from './support/withdrawals-test-context';
import {
  HOUR_MS,
  createAccountControlsHelpers,
  money,
} from './support/account-controls-helpers';

jest.setTimeout(180_000);

const TIER1_LIMIT = 5_000_000;
const CAP = 2_000_000;

describe('GET /wallet/limits with the account-takeover controls', () => {
  let ctx: WithdrawalsTestContext;
  const h = createAccountControlsHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  it('shows no user limit, pending increase or cooldown by default, and the tier as the binding limit', async () => {
    const user = await h.seedUser('plain');

    const body = await h.limits(user.userId);

    expect(body).toMatchObject({
      userLimit: null,
      pendingIncrease: null,
      cooldown: null,
      effectiveRemaining: money(TIER1_LIMIT),
      limitedBy: 'tier',
      newAccountInflow: null,
    });
  });

  it('shows the user limit and what it leaves', async () => {
    const user = await h.seedUser('own-limit');
    const to = await h.seedUser('own-limit-to', { balanceMinor: 0n });
    await ctx.dataSource.getRepository(UserLimit).save({
      userId: user.userId,
      dailyOutflowLimitMinor: 1_000_000n,
      pendingDailyOutflowLimitMinor: null,
      pendingEffectiveAt: null,
    });
    await h.transfer(user.userId, to.userId, 400_000);

    const body = await h.limits(user.userId);

    expect(body.userLimit).toEqual(money(1_000_000));
    expect(body.dailyLimit).toEqual(money(TIER1_LIMIT));
    expect(body.effectiveRemaining).toEqual(money(600_000));
    expect(body.limitedBy).toBe('user');
  });

  it('shows a pending increase with its effective time, and applies it only once due', async () => {
    const user = await h.seedUser('pending');
    const effectiveAt = new Date(Date.now() + 5 * HOUR_MS);
    await ctx.dataSource.getRepository(UserLimit).save({
      userId: user.userId,
      dailyOutflowLimitMinor: 1_000_000n,
      pendingDailyOutflowLimitMinor: 3_000_000n,
      pendingEffectiveAt: effectiveAt,
    });

    const before = await h.limits(user.userId);
    expect(before.userLimit).toEqual(money(1_000_000));
    expect(before.pendingIncrease).toEqual({
      amount: money(3_000_000),
      effectiveAt: effectiveAt.toISOString(),
    });
    expect(before.effectiveRemaining).toEqual(money(1_000_000));

    await ctx.dataSource
      .getRepository(UserLimit)
      .update({ userId: user.userId }, { pendingEffectiveAt: new Date() });

    const after = await h.limits(user.userId);
    expect(after.userLimit).toEqual(money(3_000_000));
    expect(after.pendingIncrease).toBeNull();
    expect(after.effectiveRemaining).toEqual(money(3_000_000));
  });

  it('shows the cooldown end and the rolling allowance left, and takes the smallest of the three limits', async () => {
    const user = await h.seedUser('cooling');
    const to = await h.seedUser('cooling-to', { balanceMinor: 0n });
    await h.startCooldown(user.userId);
    await h.transfer(user.userId, to.userId, 1_300_000);

    const body = await h.limits(user.userId);

    const { until } = await h.cooldownOf(user.userId);
    expect(body.cooldown).toEqual({
      endsAt: until!.toISOString(),
      limit: money(CAP),
      remaining: money(700_000),
    });
    expect(body.remainingToday).toEqual(money(TIER1_LIMIT - 1_300_000));
    expect(body.effectiveRemaining).toEqual(money(700_000));
    expect(body.limitedBy).toBe('cooldown');
  });

  it('reflects the same figure the checks enforce', async () => {
    const user = await h.seedUser('consistent');
    const to = await h.seedUser('consistent-to', { balanceMinor: 0n });
    await h.startCooldown(user.userId);
    const { effectiveRemaining } = await h.limits(user.userId);

    await expect(
      h.transfer(user.userId, to.userId, Number(effectiveRemaining.amount)),
    ).resolves.toBeDefined();
    await expect(
      h.transfer(user.userId, to.userId, 10_000),
    ).rejects.toMatchObject({ code: 'SECURITY_COOLDOWN_LIMIT' });
  });

  it('shows the new-account inflow allowance while the window is open, leaving the tier balance cap alone', async () => {
    const user = await h.seedUser('newcomer', { balanceMinor: 0n });
    const rich = await h.seedUser('newcomer-rich');
    const reached = new Date();
    await h.setUser(user.userId, { tier1ReachedAt: reached });
    await h.transfer(rich.userId, user.userId, 1_200_000);

    const body = await h.limits(user.userId);

    expect(body.balanceCap).toEqual(money(30_000_000));
    expect(body.newAccountInflow).toEqual({
      endsAt: new Date(reached.getTime() + 24 * HOUR_MS).toISOString(),
      limit: money(CAP),
      received: money(1_200_000),
      remaining: money(800_000),
    });
  });

  it('omits the new-account inflow once the window has passed', async () => {
    const user = await h.seedUser('veteran', { balanceMinor: 0n });
    await h.setUser(user.userId, {
      tier1ReachedAt: new Date(Date.now() - 25 * HOUR_MS),
    });

    expect((await h.limits(user.userId)).newAccountInflow).toBeNull();
  });
});
