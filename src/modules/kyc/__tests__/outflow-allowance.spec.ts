import {
  cooldownApplies,
  effectiveOutflow,
  newAccountCapEndsAt,
} from '../internal/outflow-allowance';
import { resolveUserLimit } from '../internal/user-limit';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-10T12:00:00.000Z');
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * HOUR);

describe('effectiveOutflow', () => {
  const base = {
    dailyLimit: 30_000_000n,
    debitedToday: 0n,
    userLimit: null,
    cooldown: null,
  };

  it('is the tier remainder when nothing else applies', () => {
    expect(effectiveOutflow({ ...base, debitedToday: 1_000_000n })).toEqual({
      remaining: 29_000_000n,
      binding: 'tier',
    });
  });

  it('takes the user limit when it is tighter than the tier', () => {
    expect(
      effectiveOutflow({
        ...base,
        userLimit: 5_000_000n,
        debitedToday: 1_000_000n,
      }),
    ).toEqual({ remaining: 4_000_000n, binding: 'user' });
  });

  it('takes the cooldown remainder when it is the tightest', () => {
    expect(
      effectiveOutflow({
        ...base,
        userLimit: 5_000_000n,
        cooldown: { cap: 2_000_000n, debitedRolling: 500_000n },
      }),
    ).toEqual({ remaining: 1_500_000n, binding: 'cooldown' });
  });

  it('measures the cooldown over the rolling sum, not the calendar day', () => {
    const result = effectiveOutflow({
      ...base,
      debitedToday: 0n,
      cooldown: { cap: 2_000_000n, debitedRolling: 1_800_000n },
    });
    expect(result).toEqual({ remaining: 200_000n, binding: 'cooldown' });
  });

  it('never goes negative once a term is already over', () => {
    expect(
      effectiveOutflow({
        ...base,
        cooldown: { cap: 2_000_000n, debitedRolling: 9_000_000n },
      }).remaining,
    ).toBe(0n);
  });

  it('keeps the earlier term on a tie', () => {
    expect(
      effectiveOutflow({
        ...base,
        userLimit: 30_000_000n,
        cooldown: { cap: 30_000_000n, debitedRolling: 0n },
      }).binding,
    ).toBe('tier');
  });
});

describe('cooldownApplies', () => {
  it('does not apply without a cooldown or after it ended', () => {
    expect(
      cooldownApplies(
        { securityCooldownUntil: null, securityCooldownStartedAt: null },
        NOW,
      ),
    ).toBe(false);
    expect(
      cooldownApplies(
        {
          securityCooldownUntil: hoursFromNow(-1),
          securityCooldownStartedAt: hoursFromNow(-25),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('applies to live sends while it is active', () => {
    expect(
      cooldownApplies(
        {
          securityCooldownUntil: hoursFromNow(20),
          securityCooldownStartedAt: hoursFromNow(-4),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('exempts a schedule created before the cooldown started', () => {
    const controls = {
      securityCooldownUntil: hoursFromNow(20),
      securityCooldownStartedAt: hoursFromNow(-4),
    };
    expect(cooldownApplies(controls, NOW, hoursFromNow(-48))).toBe(false);
    expect(cooldownApplies(controls, NOW, hoursFromNow(-2))).toBe(true);
  });

  it('keeps a schedule made during the cooldown capped after the cooldown is extended', () => {
    const extended = {
      securityCooldownUntil: hoursFromNow(23),
      securityCooldownStartedAt: hoursFromNow(-10),
    };
    expect(cooldownApplies(extended, NOW, hoursFromNow(-6))).toBe(true);
  });
});

describe('new-account window', () => {
  it('runs for 24 hours from first reaching Tier 1', () => {
    expect(
      newAccountCapEndsAt({ tier1ReachedAt: hoursFromNow(-23) }, NOW),
    ).toEqual(hoursFromNow(1));
    expect(
      newAccountCapEndsAt({ tier1ReachedAt: hoursFromNow(-24) }, NOW),
    ).toBeNull();
    expect(newAccountCapEndsAt({ tier1ReachedAt: null }, NOW)).toBeNull();
  });
});

describe('resolveUserLimit', () => {
  const row = (over: object) => ({
    dailyOutflowLimitMinor: 5_000_000n,
    pendingDailyOutflowLimitMinor: null,
    pendingEffectiveAt: null,
    ...over,
  });

  it('has no limit without a row', () => {
    expect(resolveUserLimit(null, NOW)).toEqual({ limit: null, pending: null });
  });

  it('holds a raise back until its time', () => {
    expect(
      resolveUserLimit(
        row({
          pendingDailyOutflowLimitMinor: 9_000_000n,
          pendingEffectiveAt: hoursFromNow(10),
        }),
        NOW,
      ),
    ).toEqual({
      limit: 5_000_000n,
      pending: { amount: 9_000_000n, effectiveAt: hoursFromNow(10) },
    });
  });

  it('applies a raise once its time has come', () => {
    expect(
      resolveUserLimit(
        row({
          pendingDailyOutflowLimitMinor: 9_000_000n,
          pendingEffectiveAt: hoursFromNow(-1),
        }),
        NOW,
      ),
    ).toEqual({ limit: 9_000_000n, pending: null });
  });
});
