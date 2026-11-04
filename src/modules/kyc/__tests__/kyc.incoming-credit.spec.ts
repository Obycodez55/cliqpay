import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../../config';
import { Money } from '../../../shared/primitives/money';
import { KycTier, UsersService } from '../../users/users.service';
import { KycService } from '../kyc.service';
import { TierLimit } from '../entities/tier-limit.entity';
import { TierLimitNotConfiguredException } from '../internal/errors';
import { KycProvider } from '../providers/kyc-provider.interface';

const NGN = (minor: number) => Money.of(minor, 'NGN');

describe('KycService.checkIncomingCredit', () => {
  let service: KycService;
  let calls: string[];
  let tierLimit: Pick<TierLimit, 'balanceCapMinor'> | null;
  let tier: KycTier;
  let balance: Money;
  let reader: jest.Mock<Promise<Money>, []>;
  let manager: EntityManager;

  beforeEach(() => {
    calls = [];
    tier = 'tier1';
    tierLimit = { balanceCapMinor: 30_000_000n };
    balance = NGN(0);
    reader = jest.fn(() => {
      calls.push('read');
      return Promise.resolve(balance);
    });
    manager = {
      query: jest.fn((sql: string) => {
        calls.push(sql.includes('pg_advisory_xact_lock') ? 'lock' : 'query');
        return Promise.resolve();
      }),
      getRepository: jest.fn(() => ({
        findOneBy: jest.fn(() => Promise.resolve(tierLimit)),
      })),
    } as unknown as EntityManager;
    const usersService = {
      getKycTier: jest.fn(() => Promise.resolve(tier)),
    } as unknown as UsersService;
    service = new KycService(
      {} as DataSource,
      {} as KycProvider,
      usersService,
      {
        encryption: { key: 'a'.repeat(64) },
        identifierHash: { key: 'c'.repeat(64) },
      } as AppConfig,
    );
  });

  it('takes the user lock before reading the balance', async () => {
    await service.checkIncomingCredit(manager, 'user-1', NGN(100), reader);

    expect(calls).toEqual(['lock', 'read']);
  });

  it('allows a credit that lands exactly on the cap', async () => {
    balance = NGN(25_000_000);

    await expect(
      service.checkIncomingCredit(manager, 'user-1', NGN(5_000_000), reader),
    ).resolves.toEqual({ allowed: true });
  });

  it('reports a credit over the cap with the cap and the remaining headroom, without throwing', async () => {
    balance = NGN(25_000_000);

    await expect(
      service.checkIncomingCredit(manager, 'user-1', NGN(5_000_001), reader),
    ).resolves.toEqual({
      allowed: false,
      reason: 'over_cap',
      cap: NGN(30_000_000),
      remaining: NGN(5_000_000),
    });
  });

  it('reports zero remaining headroom when the balance is already above the cap', async () => {
    balance = NGN(31_000_000);

    const verdict = await service.checkIncomingCredit(
      manager,
      'user-1',
      NGN(100),
      reader,
    );

    expect(verdict).toMatchObject({ allowed: false, remaining: NGN(0) });
  });

  it('reports a zero cap as its own reason', async () => {
    tier = 'tier0';
    tierLimit = { balanceCapMinor: 0n };

    await expect(
      service.checkIncomingCredit(manager, 'user-1', NGN(100), reader),
    ).resolves.toMatchObject({ allowed: false, reason: 'zero_cap' });
  });

  it('allows any credit when the tier has no cap, without reading the balance', async () => {
    tier = 'tier3';
    tierLimit = { balanceCapMinor: null };

    await expect(
      service.checkIncomingCredit(manager, 'user-1', NGN(999_999_999), reader),
    ).resolves.toEqual({ allowed: true });
    expect(reader).not.toHaveBeenCalled();
  });

  it('still throws when the tier has no configured limits, which is not a verdict', async () => {
    tierLimit = null;

    await expect(
      service.checkIncomingCredit(manager, 'user-1', NGN(100), reader),
    ).rejects.toThrow(TierLimitNotConfiguredException);
  });
});
