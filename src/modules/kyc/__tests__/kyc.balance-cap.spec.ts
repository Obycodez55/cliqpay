import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../../config';
import { Money } from '../../../shared/primitives/money';
import { KycTier, UsersService } from '../../users/users.service';
import { KycService } from '../kyc.service';
import { TierLimit } from '../entities/tier-limit.entity';
import {
  BalanceCapExceededException,
  KycVerificationRequiredException,
  TierLimitNotConfiguredException,
} from '../internal/errors';
import { KycProvider } from '../providers/kyc-provider.interface';

const NGN = (minor: number) => Money.of(minor, 'NGN');

describe('KycService.checkBalanceCap', () => {
  let service: KycService;
  let calls: string[];
  let tierLimit: Pick<TierLimit, 'balanceCapMinor'> | null;
  let tier: KycTier;
  let balance: Money;
  let pending: Money;
  let reader: jest.Mock<Promise<{ balance: Money; pending: Money }>, []>;
  let manager: EntityManager;

  beforeEach(() => {
    calls = [];
    tier = 'tier1';
    tierLimit = { balanceCapMinor: 30_000_000n };
    balance = NGN(0);
    pending = NGN(0);
    reader = jest.fn(() => {
      calls.push('read');
      return Promise.resolve({ balance, pending });
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
      { encryption: { key: 'a'.repeat(64) } } as AppConfig,
    );
  });

  it('takes the user lock before reading the balance', async () => {
    await service.checkBalanceCap(manager, 'user-1', NGN(100), reader);

    expect(calls).toEqual(['lock', 'read']);
  });

  it('allows an amount that lands exactly on the cap', async () => {
    balance = NGN(25_000_000);

    await expect(
      service.checkBalanceCap(manager, 'user-1', NGN(5_000_000), reader),
    ).resolves.toBeUndefined();
  });

  it('rejects one kobo over the cap and reports the headroom', async () => {
    balance = NGN(25_000_000);

    const error = await service
      .checkBalanceCap(manager, 'user-1', NGN(5_000_001), reader)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BalanceCapExceededException);
    expect((error as BalanceCapExceededException).details).toEqual({
      balanceCap: { amount: '30000000', currency: 'NGN' },
      remaining: { amount: '5000000', currency: 'NGN' },
    });
  });

  it('counts in-flight pending fundings against the headroom', async () => {
    balance = NGN(10_000_000);
    pending = NGN(19_000_000);

    const error = await service
      .checkBalanceCap(manager, 'user-1', NGN(1_000_001), reader)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BalanceCapExceededException);
    expect((error as BalanceCapExceededException).details.remaining).toEqual({
      amount: '1000000',
      currency: 'NGN',
    });
    await expect(
      service.checkBalanceCap(manager, 'user-1', NGN(1_000_000), reader),
    ).resolves.toBeUndefined();
  });

  it('reports zero headroom, not a negative one, when already over the cap', async () => {
    balance = NGN(31_000_000);

    const error = await service
      .checkBalanceCap(manager, 'user-1', NGN(1), reader)
      .catch((e: unknown) => e);

    expect((error as BalanceCapExceededException).details.remaining).toEqual({
      amount: '0',
      currency: 'NGN',
    });
  });

  it('skips the check entirely when the tier has no cap', async () => {
    tier = 'tier3';
    tierLimit = { balanceCapMinor: null };
    balance = NGN(900_000_000_000);

    await expect(
      service.checkBalanceCap(manager, 'user-1', NGN(900_000_000_000), reader),
    ).resolves.toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });

  it('asks for verification, rather than quoting a ₦0 headroom, when the cap is zero', async () => {
    tier = 'tier0';
    tierLimit = { balanceCapMinor: 0n };

    await expect(
      service.checkBalanceCap(manager, 'user-1', NGN(1), reader),
    ).rejects.toThrow(KycVerificationRequiredException);
    expect(reader).not.toHaveBeenCalled();
  });

  it('fails closed with a configuration error when the tier has no limit row', async () => {
    tierLimit = null;

    await expect(
      service.checkBalanceCap(manager, 'user-1', NGN(100), reader),
    ).rejects.toThrow(TierLimitNotConfiguredException);
    expect(reader).not.toHaveBeenCalled();
  });
});
