import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../../config';
import { Money } from '../../../shared/primitives/money';
import { KycTier, UsersService } from '../../users/users.service';
import { KycService } from '../kyc.service';
import { TierLimit } from '../entities/tier-limit.entity';
import { TierLimitNotConfiguredException } from '../internal/errors';
import { KycProvider } from '../providers/kyc-provider.interface';

const NGN = (minor: number) => Money.of(minor, 'NGN');

const TIER_LIMITS: Record<
  KycTier,
  Pick<TierLimit, 'dailyDebitLimitMinor' | 'balanceCapMinor'>
> = {
  tier0: { dailyDebitLimitMinor: 0n, balanceCapMinor: 0n },
  tier1: { dailyDebitLimitMinor: 5_000_000n, balanceCapMinor: 30_000_000n },
  tier2: { dailyDebitLimitMinor: 20_000_000n, balanceCapMinor: 50_000_000n },
  tier3: { dailyDebitLimitMinor: 500_000_000n, balanceCapMinor: null },
};

describe('KycService.getWalletCapacity', () => {
  let service: KycService;
  let tier: KycTier;
  let tierLimitMissing: boolean;
  let debited: Money;
  let balance: Money;
  let pending: Money;
  let readDebitedSince: jest.Mock<Promise<Money>, [EntityManager, Date]>;
  let manager: { query: jest.Mock; getRepository: jest.Mock };

  const capacity = () =>
    service.getWalletCapacity(
      manager as unknown as EntityManager,
      'user-1',
      'NGN',
      {
        readDebitedSince,
        readBalanceAndPending: () => Promise.resolve({ balance, pending }),
      },
    );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-17T10:00:00.000Z'));
    tier = 'tier1';
    tierLimitMissing = false;
    debited = NGN(0);
    balance = NGN(0);
    pending = NGN(0);
    readDebitedSince = jest.fn((_m: EntityManager, _since: Date) =>
      Promise.resolve(debited),
    );
    manager = {
      query: jest.fn(),
      getRepository: jest.fn(() => ({
        findOneBy: jest.fn(() =>
          Promise.resolve(
            tierLimitMissing ? null : { tier, ...TIER_LIMITS[tier] },
          ),
        ),
      })),
    };
    service = new KycService(
      {} as DataSource,
      {} as KycProvider,
      {
        getKycTier: jest.fn(() => Promise.resolve(tier)),
      } as unknown as UsersService,
      {
        encryption: { key: 'a'.repeat(64) },
        identifierHash: { key: 'c'.repeat(64) },
      } as AppConfig,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['tier1', 5_000_000, 30_000_000],
    ['tier2', 20_000_000, 50_000_000],
  ] as const)(
    'reports the %s limit, cap and headroom',
    async (t, limit, cap) => {
      tier = t;
      debited = NGN(1_000_000);
      balance = NGN(10_000_000);

      const result = await capacity();

      expect(result.tier).toBe(t);
      expect(result.dailyLimit).toEqual(NGN(limit));
      expect(result.debitedToday).toEqual(NGN(1_000_000));
      expect(result.remainingToday).toEqual(NGN(limit - 1_000_000));
      expect(result.balanceCap).toEqual(NGN(cap));
      expect(result.balance).toEqual(NGN(10_000_000));
      expect(result.headroom).toEqual(NGN(cap - 10_000_000));
    },
  );

  it('reports no cap and no headroom for an uncapped tier', async () => {
    tier = 'tier3';
    balance = NGN(900_000_000);

    const result = await capacity();

    expect(result.dailyLimit).toEqual(NGN(500_000_000));
    expect(result.balanceCap).toBeNull();
    expect(result.headroom).toBeNull();
  });

  it('returns zeros for tier 0 without throwing', async () => {
    tier = 'tier0';

    const result = await capacity();

    expect(result.dailyLimit).toEqual(NGN(0));
    expect(result.remainingToday).toEqual(NGN(0));
    expect(result.balanceCap).toEqual(NGN(0));
    expect(result.headroom).toEqual(NGN(0));
  });

  it('counts pending fundings against the headroom', async () => {
    balance = NGN(10_000_000);
    pending = NGN(5_000_000);

    const result = await capacity();

    expect(result.pendingFunding).toEqual(NGN(5_000_000));
    expect(result.headroom).toEqual(NGN(15_000_000));
  });

  it('never reports a negative allowance or headroom when already over', async () => {
    debited = NGN(5_500_000);
    balance = NGN(29_000_000);
    pending = NGN(2_000_000);

    const result = await capacity();

    expect(result.remainingToday).toEqual(NGN(0));
    expect(result.headroom).toEqual(NGN(0));
  });

  it('reads the debited sum from the start of the Lagos day', async () => {
    await capacity();

    expect(readDebitedSince.mock.calls[0][1].toISOString()).toBe(
      '2026-10-16T23:00:00.000Z',
    );
  });

  it.each([
    ['2026-10-17T22:59:59.000Z', '2026-10-17T23:00:00.000Z'],
    ['2026-10-17T23:00:00.000Z', '2026-10-18T23:00:00.000Z'],
    ['2026-10-17T00:30:00.000Z', '2026-10-17T23:00:00.000Z'],
  ])('resets at the next Lagos midnight: %s -> %s', async (now, resetsAt) => {
    jest.setSystemTime(new Date(now));

    expect((await capacity()).resetsAt.toISOString()).toBe(resetsAt);
  });

  it('takes no lock and writes nothing', async () => {
    await capacity();

    expect(manager.query).not.toHaveBeenCalled();
  });

  it('fails closed with a configuration error when the tier has no limit row', async () => {
    tierLimitMissing = true;

    await expect(capacity()).rejects.toThrow(TierLimitNotConfiguredException);
  });
});
