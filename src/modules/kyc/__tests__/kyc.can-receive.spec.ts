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

describe('KycService.checkCanReceive', () => {
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
      {
        encryption: { key: 'a'.repeat(64) },
        identifierHash: { key: 'c'.repeat(64) },
      } as AppConfig,
    );
  });

  const check = (amount: Money) =>
    service.checkCanReceive(manager, 'user-1', amount, reader);

  it('takes no lock and writes nothing', async () => {
    balance = NGN(1_000);

    await check(NGN(100));

    expect(calls).toEqual(['read']);
  });

  it('allows an amount that lands exactly on the cap', async () => {
    balance = NGN(25_000_000);

    await expect(check(NGN(5_000_000))).resolves.toBeUndefined();
  });

  it('rejects one kobo over the cap and reports the headroom', async () => {
    balance = NGN(25_000_000);

    const error = await check(NGN(5_000_001)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BalanceCapExceededException);
    expect((error as BalanceCapExceededException).details).toEqual({
      balanceCap: { amount: '30000000', currency: 'NGN' },
      remaining: { amount: '5000000', currency: 'NGN' },
    });
    expect((error as BalanceCapExceededException).message).toContain(
      'request up to',
    );
  });

  it('counts in-flight pending fundings against the headroom', async () => {
    balance = NGN(10_000_000);
    pending = NGN(19_000_000);

    const error = await check(NGN(1_000_001)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BalanceCapExceededException);
    expect((error as BalanceCapExceededException).details.remaining).toEqual({
      amount: '1000000',
      currency: 'NGN',
    });
    await expect(check(NGN(1_000_000))).resolves.toBeUndefined();
  });

  it('asks a tier-0 user to verify before requesting money', async () => {
    tier = 'tier0';
    tierLimit = { balanceCapMinor: 0n };

    const error = await check(NGN(1)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KycVerificationRequiredException);
    expect((error as Error).message).toBe(
      'Verify your BVN or NIN before requesting money.',
    );
    expect(reader).not.toHaveBeenCalled();
  });

  it('always passes for a tier with no cap', async () => {
    tier = 'tier3';
    tierLimit = { balanceCapMinor: null };
    balance = NGN(900_000_000_000);

    await expect(check(NGN(900_000_000_000))).resolves.toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });

  it('fails closed with a configuration error when the tier has no limit row', async () => {
    tierLimit = null;

    await expect(check(NGN(100))).rejects.toThrow(
      TierLimitNotConfiguredException,
    );
    expect(reader).not.toHaveBeenCalled();
  });
});
