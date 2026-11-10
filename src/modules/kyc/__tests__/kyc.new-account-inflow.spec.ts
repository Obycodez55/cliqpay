import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../../config';
import { Money } from '../../../shared/primitives/money';
import { UsersService } from '../../users/users.service';
import { KycService } from '../kyc.service';
import { TierLimit } from '../entities/tier-limit.entity';
import { NewAccountInflowLimitException } from '../internal/errors';
import { UserLimitsService } from '../internal/user-limits.service';
import { KycProvider } from '../providers/kyc-provider.interface';

const NGN = (minor: number) => Money.of(minor, 'NGN');
const HOUR = 60 * 60 * 1000;

describe('KycService new-account inflow cap', () => {
  let service: KycService;
  let tier1ReachedAt: Date | null;
  let tierCap: bigint | null;
  let received: Money;
  let balance: Money;
  let pending: Money;
  let manager: EntityManager;
  let reader: jest.Mock<
    Promise<{ balance: Money; pending: Money; received: Money }>,
    [EntityManager, Date | null]
  >;

  beforeEach(() => {
    tier1ReachedAt = new Date(Date.now() - HOUR);
    tierCap = 30_000_000n;
    received = NGN(0);
    balance = NGN(0);
    pending = NGN(0);
    reader = jest.fn((_m: EntityManager, _since: Date | null) =>
      Promise.resolve({ balance, pending, received }),
    );
    manager = {
      query: jest.fn(),
      getRepository: jest.fn(() => ({
        findOneBy: jest.fn(() =>
          Promise.resolve({ balanceCapMinor: tierCap } as TierLimit),
        ),
      })),
    } as unknown as EntityManager;
    service = new KycService(
      {} as DataSource,
      {} as KycProvider,
      {
        getKycTier: jest.fn(() => Promise.resolve('tier1')),
        getSecurityControls: jest.fn(() =>
          Promise.resolve({
            securityCooldownUntil: null,
            securityCooldownStartedAt: null,
            tier1ReachedAt,
          }),
        ),
      } as unknown as UsersService,
      {
        encryption: { key: 'a'.repeat(64) },
        identifierHash: { key: 'c'.repeat(64) },
        securityControls: {
          cooldownLimit: 2_000_000,
          bankAccountCoolingLimit: 2_000_000,
        },
      } as AppConfig,
      {} as UserLimitsService,
    );
  });

  const verdict = (amount: number) =>
    service.checkIncomingCredit(manager, 'user-1', NGN(amount), reader);

  it('asks the reader for inflow since the window started', async () => {
    await verdict(100);

    expect(reader.mock.calls[0][1]).toEqual(tier1ReachedAt);
  });

  it('allows an amount that lands exactly on the cap', async () => {
    received = NGN(1_500_000);

    expect(await verdict(500_000)).toEqual({ allowed: true });
  });

  it('refuses one kobo over, whatever the balance is', async () => {
    received = NGN(1_500_000);
    balance = NGN(0);

    const result = await verdict(500_001);

    expect(result).toMatchObject({
      allowed: false,
      reason: 'new_account_inflow',
      remaining: NGN(500_000),
    });
  });

  it('counts fundings in flight as projected inflow when asked to', async () => {
    received = NGN(1_000_000);
    pending = NGN(900_000);

    await expect(
      service.checkBalanceCap(manager, 'user-1', NGN(200_000), reader),
    ).rejects.toBeInstanceOf(NewAccountInflowLimitException);
  });

  it('does not look at inflow once the window is over', async () => {
    tier1ReachedAt = new Date(Date.now() - 25 * HOUR);
    received = NGN(9_000_000);

    expect(await verdict(100)).toEqual({ allowed: true });
    expect(reader.mock.calls[0][1]).toBeNull();
  });

  it('skips the reader for an uncapped tier outside the window', async () => {
    tier1ReachedAt = null;
    tierCap = null;

    expect(await verdict(100)).toEqual({ allowed: true });
    expect(reader).not.toHaveBeenCalled();
  });
});
