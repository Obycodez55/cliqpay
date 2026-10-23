import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../../config';
import { Money } from '../../../shared/primitives/money';
import { KycTier, UsersService } from '../../users/users.service';
import { KycService } from '../kyc.service';
import { TierLimit } from '../entities/tier-limit.entity';
import {
  DailyLimitExceededException,
  KycVerificationRequiredException,
  TierLimitNotConfiguredException,
} from '../internal/errors';
import { KycProvider } from '../providers/kyc-provider.interface';

const NGN = (minor: number) => Money.of(minor, 'NGN');

describe('KycService.checkAndReserveLimit', () => {
  let service: KycService;
  let calls: string[];
  let tierLimit: Pick<TierLimit, 'dailyDebitLimitMinor'> | null;
  let tier: KycTier;
  let debited: Money;
  let reader: jest.Mock<Promise<Money>, [EntityManager, Date]>;
  let manager: EntityManager;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-17T22:59:59.000Z'));
    calls = [];
    tier = 'tier1';
    tierLimit = { dailyDebitLimitMinor: 5_000_000n };
    debited = NGN(0);
    reader = jest.fn((_m: EntityManager, _since: Date) => {
      calls.push('read');
      return Promise.resolve(debited);
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

  afterEach(() => {
    jest.useRealTimers();
  });

  it('takes the user lock before reading the debited sum', async () => {
    await service.checkAndReserveLimit(manager, 'user-1', NGN(100), reader);

    expect(calls).toEqual(['lock', 'read']);
  });

  it('reads the sum from the start of the current Lagos day', async () => {
    await service.checkAndReserveLimit(manager, 'user-1', NGN(100), reader);

    expect(reader.mock.calls[0][1].toISOString()).toBe(
      '2026-10-16T23:00:00.000Z',
    );
  });

  it('allows an amount that lands exactly on the limit', async () => {
    debited = NGN(4_000_000);

    await expect(
      service.checkAndReserveLimit(manager, 'user-1', NGN(1_000_000), reader),
    ).resolves.toBeUndefined();
  });

  it('rejects one kobo over the limit and reports the remaining allowance', async () => {
    debited = NGN(4_000_000);

    const error = await service
      .checkAndReserveLimit(manager, 'user-1', NGN(1_000_001), reader)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DailyLimitExceededException);
    expect((error as DailyLimitExceededException).details).toEqual({
      dailyLimit: { amount: '5000000', currency: 'NGN' },
      remaining: { amount: '1000000', currency: 'NGN' },
    });
  });

  it('counts what was already debited today against the limit', async () => {
    debited = NGN(5_000_000);

    await expect(
      service.checkAndReserveLimit(manager, 'user-1', NGN(1), reader),
    ).rejects.toThrow(DailyLimitExceededException);
  });

  it('reports a zero allowance, not a negative one, when the day is already over the limit', async () => {
    debited = NGN(5_500_000);

    const error = await service
      .checkAndReserveLimit(manager, 'user-1', NGN(1), reader)
      .catch((e: unknown) => e);

    expect((error as DailyLimitExceededException).details.remaining).toEqual({
      amount: '0',
      currency: 'NGN',
    });
  });

  it('asks for verification, rather than quoting a ₦0 limit, when the tier limit is zero', async () => {
    tier = 'tier0';
    tierLimit = { dailyDebitLimitMinor: 0n };

    await expect(
      service.checkAndReserveLimit(manager, 'user-1', NGN(1), reader),
    ).rejects.toThrow(KycVerificationRequiredException);
    expect(reader).not.toHaveBeenCalled();
  });

  it('fails closed with a configuration error when the tier has no limit row', async () => {
    tierLimit = null;

    await expect(
      service.checkAndReserveLimit(manager, 'user-1', NGN(100), reader),
    ).rejects.toThrow(TierLimitNotConfiguredException);
    expect(reader).not.toHaveBeenCalled();
  });
});
