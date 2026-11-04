import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../../config';
import { Money } from '../../../shared/primitives/money';
import { KycTier, UsersService } from '../../users/users.service';
import { KycService } from '../kyc.service';
import { TierLimit } from '../entities/tier-limit.entity';
import {
  DailyLimitExceededException,
  RecipientCannotReceiveException,
} from '../internal/errors';
import { KycProvider } from '../providers/kyc-provider.interface';

const NGN = (minor: number) => Money.of(minor, 'NGN');

describe('KycService.checkTransferLimits', () => {
  let service: KycService;
  let events: string[];
  let hashKeys: Record<string, number>;
  let tiers: Record<string, KycTier>;
  let limits: Record<
    KycTier,
    Pick<TierLimit, 'dailyDebitLimitMinor' | 'balanceCapMinor'>
  >;
  let debited: Money;
  let recipientBalance: { balance: Money; pending: Money };
  let manager: EntityManager;
  let readers: Parameters<KycService['checkTransferLimits']>[4];

  beforeEach(() => {
    events = [];
    hashKeys = { alice: 100, bob: 200 };
    tiers = { alice: 'tier1', bob: 'tier1' };
    limits = {
      tier0: { dailyDebitLimitMinor: 0n, balanceCapMinor: 0n },
      tier1: { dailyDebitLimitMinor: 5_000_000n, balanceCapMinor: 30_000_000n },
      tier2: {
        dailyDebitLimitMinor: 20_000_000n,
        balanceCapMinor: 50_000_000n,
      },
      tier3: { dailyDebitLimitMinor: 500_000_000n, balanceCapMinor: null },
    };
    debited = NGN(0);
    recipientBalance = { balance: NGN(0), pending: NGN(0) };
    let currentUser = '';
    manager = {
      query: jest.fn((sql: string, params: unknown[]) => {
        if (sql.startsWith('SELECT hashtext')) {
          return Promise.resolve([
            {
              a: hashKeys[params[0] as string],
              b: hashKeys[params[1] as string],
            },
          ]);
        }
        events.push(`lock:${String(params[0])}`);
        return Promise.resolve();
      }),
      getRepository: jest.fn(() => ({
        findOneBy: jest.fn(({ tier }: { tier: KycTier }) =>
          Promise.resolve(limits[tier]),
        ),
      })),
    } as unknown as EntityManager;
    const usersService = {
      getKycTier: jest.fn((_m: EntityManager, userId: string) => {
        currentUser = userId;
        events.push(`tier:${currentUser}`);
        return Promise.resolve(tiers[userId]);
      }),
    } as unknown as UsersService;
    readers = {
      readDebitedSince: jest.fn(() => {
        events.push('read-debited');
        return Promise.resolve(debited);
      }),
      readRecipientBalanceAndPending: jest.fn(() => {
        events.push('read-recipient');
        return Promise.resolve(recipientBalance);
      }),
    };
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

  const check = (sender: string, recipient: string, amount = NGN(100)) =>
    service.checkTransferLimits(manager, sender, recipient, amount, readers);

  describe('lock ordering', () => {
    it('takes the same locks in the same order for A->B and B->A', async () => {
      await check('alice', 'bob');
      const forward = events.filter((e) => e.startsWith('lock:'));
      events.length = 0;
      await check('bob', 'alice');
      const reverse = events.filter((e) => e.startsWith('lock:'));

      expect(forward).toEqual(['lock:100', 'lock:200']);
      expect(reverse).toEqual(forward);
    });

    it('orders by numeric lock key, not by user id', async () => {
      hashKeys = { alice: 900, bob: -5 };

      await check('alice', 'bob');

      expect(events.filter((e) => e.startsWith('lock:'))).toEqual([
        'lock:-5',
        'lock:900',
      ]);
    });

    it('takes a single lock when both keys are equal', async () => {
      hashKeys = { alice: 7, bob: 7 };

      await check('alice', 'bob');

      expect(events.filter((e) => e.startsWith('lock:'))).toEqual(['lock:7']);
    });

    it('holds both locks before reading either side', async () => {
      await check('alice', 'bob');

      const lastLock = events.lastIndexOf('lock:200');
      expect(lastLock).toBeLessThan(events.indexOf('tier:alice'));
      expect(lastLock).toBeLessThan(events.indexOf('read-debited'));
    });
  });

  describe('checks', () => {
    it('allows a transfer within the sender limit and the recipient cap', async () => {
      await expect(check('alice', 'bob')).resolves.toBeUndefined();
    });

    it('checks the sender limit first, with the existing error', async () => {
      debited = NGN(5_000_000);
      recipientBalance = { balance: NGN(30_000_000), pending: NGN(0) };

      await expect(check('alice', 'bob')).rejects.toThrow(
        DailyLimitExceededException,
      );
      expect(readers.readRecipientBalanceAndPending).not.toHaveBeenCalled();
    });

    it('allows a recipient landing exactly on the cap', async () => {
      recipientBalance = { balance: NGN(29_999_900), pending: NGN(0) };

      await expect(check('alice', 'bob', NGN(100))).resolves.toBeUndefined();
    });

    it('rejects one kobo over the recipient cap with the generic error', async () => {
      recipientBalance = { balance: NGN(29_999_900), pending: NGN(0) };

      const error = await check('alice', 'bob', NGN(101)).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(RecipientCannotReceiveException);
      expect((error as RecipientCannotReceiveException).message).toBe(
        "This recipient can't receive this amount right now.",
      );
      expect((error as { details?: unknown }).details).toBeUndefined();
    });

    it("counts the recipient's pending funding toward their cap", async () => {
      recipientBalance = { balance: NGN(10_000_000), pending: NGN(19_999_950) };

      await expect(check('alice', 'bob', NGN(100))).rejects.toThrow(
        RecipientCannotReceiveException,
      );
    });

    it('rejects a tier-0 recipient (zero cap) with the same generic error', async () => {
      tiers.bob = 'tier0';

      await expect(check('alice', 'bob')).rejects.toThrow(
        RecipientCannotReceiveException,
      );
      expect(readers.readRecipientBalanceAndPending).not.toHaveBeenCalled();
    });

    it('never caps a tier-3 recipient', async () => {
      tiers.bob = 'tier3';
      recipientBalance = { balance: NGN(900_000_000_000), pending: NGN(0) };

      await expect(check('alice', 'bob')).resolves.toBeUndefined();
      expect(readers.readRecipientBalanceAndPending).not.toHaveBeenCalled();
    });
  });
});
