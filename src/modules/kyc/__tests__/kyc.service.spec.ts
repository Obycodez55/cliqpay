import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../../config';
import {
  encryptionKeyFromHex,
  hmacHex,
} from '../../../shared/crypto/secrets.util';
import { KycTier, UsersService } from '../../users/users.service';
import { LivenessCaptureDto } from '../dto/liveness-capture.dto';
import { KycService } from '../kyc.service';
import { KycVerification } from '../entities/kyc-verification.entity';
import { KycVerificationAttempt } from '../entities/kyc-verification-attempt.entity';
import { KycLivenessJob } from '../entities/kyc-liveness-job.entity';
import { TierLimit } from '../entities/tier-limit.entity';
import {
  KycProvider,
  KycVerificationResult,
  LivenessSubmissionResult,
} from '../providers/kyc-provider.interface';
import {
  BvnAlreadyLinkedException,
  BvnAlreadyVerifiedException,
  BvnVerificationFailedException,
  NinAlreadyLinkedException,
  NinAlreadyVerifiedException,
  NinVerificationFailedException,
  IdentityMismatchException,
  LivenessInProgressException,
  TooManyVerificationAttemptsException,
} from '../internal/errors';

type FakeKycVerificationRepo = {
  findOneBy: jest.Mock<
    Promise<KycVerification | null>,
    [Partial<KycVerification>]
  >;
  findOneByOrFail: jest.Mock<
    Promise<KycVerification>,
    [Partial<KycVerification>]
  >;
  create: jest.Mock<KycVerification, [Partial<KycVerification>]>;
  save: jest.Mock<Promise<KycVerification>, [KycVerification]>;
};

type FakeAttemptRepo = {
  count: jest.Mock<Promise<number>, [unknown]>;
  create: jest.Mock<KycVerificationAttempt, [Partial<KycVerificationAttempt>]>;
  save: jest.Mock<Promise<KycVerificationAttempt>, [KycVerificationAttempt]>;
  update: jest.Mock<
    Promise<unknown>,
    [Partial<KycVerificationAttempt>, Partial<KycVerificationAttempt>]
  >;
  delete: jest.Mock<Promise<unknown>, [Partial<KycVerificationAttempt>]>;
};

type FakeJobRepo = {
  countBy: jest.Mock<Promise<number>, [unknown]>;
  create: jest.Mock<KycLivenessJob, [Partial<KycLivenessJob>]>;
  save: jest.Mock<Promise<KycLivenessJob>, [KycLivenessJob]>;
  update: jest.Mock<Promise<unknown>, [unknown, unknown]>;
  findOneBy: jest.Mock<Promise<KycLivenessJob | null>, [unknown]>;
  find: jest.Mock<Promise<KycLivenessJob[]>, [unknown]>;
  increment: jest.Mock<Promise<unknown>, [unknown, string, number]>;
};

const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

function testConfig(): AppConfig {
  return {
    encryption: { key: TEST_ENCRYPTION_KEY },
  } as unknown as AppConfig;
}

function verifiedResult(): KycVerificationResult {
  return {
    status: 'verified',
    legalName: 'Ada Lovelace',
    address: {
      street: '1 Test St',
      town: 'Ikeja',
      lga: 'Ikeja',
      state: 'Lagos',
    },
  };
}

describe('KycService', () => {
  let service: KycService;
  let kycVerificationRepo: FakeKycVerificationRepo;
  let attemptRepo: FakeAttemptRepo;
  let managerQuery: jest.Mock<Promise<unknown>, [string, unknown[]]>;
  let fakeManager: EntityManager;
  let dataSource: jest.Mocked<
    Pick<DataSource, 'getRepository' | 'transaction'>
  >;
  let kycProvider: jest.Mocked<Pick<KycProvider, keyof KycProvider>>;
  let jobRepo: FakeJobRepo;
  let tierLimitRepo: {
    findOneBy: jest.Mock<Promise<TierLimit | null>, [unknown]>;
  };
  let usersService: {
    findById: jest.Mock<Promise<Record<string, unknown>>, [string]>;
    getKycTier: jest.Mock<Promise<KycTier>, [EntityManager, string]>;
    setKycTier: jest.Mock<Promise<void>, [EntityManager, string, KycTier]>;
  };

  beforeEach(() => {
    kycVerificationRepo = {
      findOneBy: jest
        .fn<Promise<KycVerification | null>, [Partial<KycVerification>]>()
        .mockResolvedValue(null),
      findOneByOrFail: jest.fn((where: Partial<KycVerification>) =>
        kycVerificationRepo.findOneBy(where).then((record) => record!),
      ),
      create: jest.fn(
        (data: Partial<KycVerification>) => data as KycVerification,
      ),
      save: jest.fn((entity: KycVerification) => {
        kycVerificationRepo.findOneBy.mockResolvedValue(entity);
        return Promise.resolve(entity);
      }),
    };
    attemptRepo = {
      count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
      create: jest.fn(
        (data: Partial<KycVerificationAttempt>) =>
          data as KycVerificationAttempt,
      ),
      save: jest.fn((entity: KycVerificationAttempt) =>
        Promise.resolve({ ...entity, id: 'attempt-1' }),
      ),
      update: jest
        .fn<
          Promise<unknown>,
          [Partial<KycVerificationAttempt>, Partial<KycVerificationAttempt>]
        >()
        .mockResolvedValue(undefined),
      delete: jest
        .fn<Promise<unknown>, [Partial<KycVerificationAttempt>]>()
        .mockResolvedValue(undefined),
    };
    tierLimitRepo = {
      findOneBy: jest.fn<Promise<TierLimit | null>, [unknown]>(
        ({ tier }: { tier?: string } = {}) =>
          Promise.resolve(
            (tier === 'tier1'
              ? {
                  dailyDebitLimitMinor: 5_000_000n,
                  balanceCapMinor: 30_000_000n,
                }
              : { dailyDebitLimitMinor: 0n, balanceCapMinor: 0n }) as TierLimit,
          ),
      ),
    };
    jobRepo = {
      countBy: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
      create: jest.fn(
        (data: Partial<KycLivenessJob>) => data as KycLivenessJob,
      ),
      save: jest.fn((entity: KycLivenessJob) =>
        Promise.resolve({ ...entity, id: 'job-1' }),
      ),
      update: jest
        .fn<Promise<unknown>, [unknown, unknown]>()
        .mockResolvedValue(undefined),
      findOneBy: jest
        .fn<Promise<KycLivenessJob | null>, [unknown]>()
        .mockResolvedValue(null),
      find: jest
        .fn<Promise<KycLivenessJob[]>, [unknown]>()
        .mockResolvedValue([]),
      increment: jest
        .fn<Promise<unknown>, [unknown, string, number]>()
        .mockResolvedValue(undefined),
    };
    managerQuery = jest
      .fn<Promise<unknown>, [string, unknown[]]>()
      .mockResolvedValue(undefined);
    const getRepositoryMock = jest.fn((entity: unknown) => {
      if (entity === KycVerification) return kycVerificationRepo;
      if (entity === KycVerificationAttempt) return attemptRepo;
      if (entity === KycLivenessJob) return jobRepo;
      if (entity === TierLimit) return tierLimitRepo;
      throw new Error('unexpected entity passed to getRepository');
    });
    fakeManager = {
      getRepository: getRepositoryMock,
      query: managerQuery,
    } as unknown as EntityManager;
    dataSource = {
      getRepository: getRepositoryMock,
      transaction: jest.fn(
        async (cb: (manager: EntityManager) => Promise<unknown>) =>
          cb(fakeManager),
      ),
    } as unknown as jest.Mocked<
      Pick<DataSource, 'getRepository' | 'transaction'>
    >;
    kycProvider = {
      verifyBvn: jest
        .fn<Promise<KycVerificationResult>, [string]>()
        .mockResolvedValue(verifiedResult()),
      verifyNin: jest
        .fn<Promise<KycVerificationResult>, [string]>()
        .mockResolvedValue(verifiedResult()),
      submitLiveness: jest
        .fn<Promise<LivenessSubmissionResult>, [unknown]>()
        .mockResolvedValue({ status: 'passed' }),
      getLivenessResult: jest.fn().mockResolvedValue('pending'),
      parseWebhookJobId: jest.fn().mockReturnValue(null),
    } as unknown as typeof kycProvider;
    usersService = {
      findById: jest
        .fn<Promise<Record<string, unknown>>, [string]>()
        .mockResolvedValue({
          id: 'user-1',
          kycTier: 'tier0',
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
          phone: '+2348000000000',
        }),
      getKycTier: jest
        .fn<Promise<KycTier>, [EntityManager, string]>()
        .mockResolvedValue('tier0'),
      setKycTier: jest
        .fn<Promise<void>, [EntityManager, string, KycTier]>()
        .mockImplementation((_manager, _userId, tier) => {
          usersService.getKycTier.mockResolvedValue(tier);
          return Promise.resolve();
        }),
    };

    service = new KycService(
      dataSource as unknown as DataSource,
      kycProvider,
      usersService as unknown as UsersService,
      testConfig(),
    );
  });

  describe('verifyBvn', () => {
    it('upgrades a tier0 user to tier1 on first successful verification', async () => {
      const result = await service.verifyBvn('user-1', '12345678901');

      const saved = kycVerificationRepo.save.mock.calls[0][0];
      expect(saved.userId).toBe('user-1');
      expect(typeof saved.bvnHash).toBe('string');
      expect(typeof saved.bvnCiphertext).toBe('string');
      expect(saved.verifiedLegalName).toBe('Ada Lovelace');
      expect(saved.address).toEqual({ bvn: verifiedResult().address });
      expect(attemptRepo.update).toHaveBeenCalledWith(
        { id: 'attempt-1' },
        { succeeded: true },
      );
      expect(usersService.setKycTier).toHaveBeenCalledWith(
        fakeManager,
        'user-1',
        'tier1',
      );
      expect(result).toEqual({
        tier: 'tier1',
        bvnVerified: true,
        ninVerified: false,
        livenessVerified: false,
        livenessResult: 'not_requested',
      });
    });

    it('merges the BVN address into the stored object without touching the NIN address', async () => {
      const ninAddress = {
        street: '2 Other St',
        town: 'Yaba',
        lga: 'Yaba',
        state: 'Lagos',
      };
      kycVerificationRepo.findOneBy.mockResolvedValue({
        userId: 'user-1',
        ninHash: 'nin-hash',
        identity: { nin: { legalName: 'Ada Lovelace' } },
        livenessVerified: false,
        address: { nin: ninAddress },
      } as KycVerification);

      await service.verifyBvn('user-1', '12345678901');

      expect(kycVerificationRepo.save.mock.calls[0][0].address).toEqual({
        bvn: verifiedResult().address,
        nin: ninAddress,
      });
    });

    it('takes the per-user lock before reading the verification row and the current tier', async () => {
      await service.verifyBvn('user-1', '12345678901');

      const lockCalls = managerQuery.mock.invocationCallOrder;
      const readCalls = kycVerificationRepo.findOneBy.mock.invocationCallOrder;
      for (const [lockSql, lockArgs] of managerQuery.mock.calls) {
        expect(lockSql).toContain('pg_advisory_xact_lock');
        expect(lockArgs).toEqual(['user-1']);
      }
      expect(lockCalls[0]).toBeLessThan(readCalls[0]);
      expect(lockCalls[1]).toBeLessThan(readCalls[1]);
      expect(lockCalls[1]).toBeLessThan(
        usersService.getKycTier.mock.invocationCallOrder[0],
      );
      expect(usersService.getKycTier).toHaveBeenCalledWith(
        fakeManager,
        'user-1',
      );
    });

    it('keeps the reserved attempt counted as failed and persists nothing when the provider does not verify', async () => {
      kycProvider.verifyBvn.mockResolvedValue({ status: 'not_found' });

      await expect(service.verifyBvn('user-1', '00000000000')).rejects.toThrow(
        BvnVerificationFailedException,
      );
      expect(attemptRepo.save).toHaveBeenCalledTimes(1);
      expect(attemptRepo.update).not.toHaveBeenCalled();
      expect(attemptRepo.delete).not.toHaveBeenCalled();
      expect(kycVerificationRepo.save).not.toHaveBeenCalled();
      expect(usersService.setKycTier).not.toHaveBeenCalled();
    });

    it('releases the reserved attempt when the provider itself errors', async () => {
      kycProvider.verifyBvn.mockRejectedValue(new Error('provider down'));

      await expect(service.verifyBvn('user-1', '12345678901')).rejects.toThrow(
        'provider down',
      );
      expect(attemptRepo.delete).toHaveBeenCalledWith({ id: 'attempt-1' });
    });

    it('throws before reserving or calling the provider once the rate limit is exceeded', async () => {
      attemptRepo.count.mockResolvedValue(5);

      await expect(service.verifyBvn('user-1', '12345678901')).rejects.toThrow(
        TooManyVerificationAttemptsException,
      );
      expect(attemptRepo.save).not.toHaveBeenCalled();
      expect(kycProvider.verifyBvn).not.toHaveBeenCalled();
    });

    it('maps a bvn_hash unique violation to a conflict error without marking the attempt successful', async () => {
      const violation = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'UQ_kyc_verifications_bvn_hash_partial',
      });
      kycVerificationRepo.save.mockRejectedValue(violation);

      await expect(service.verifyBvn('user-1', '12345678901')).rejects.toThrow(
        BvnAlreadyLinkedException,
      );
      expect(attemptRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('verified identity immutability', () => {
    const key = encryptionKeyFromHex(TEST_ENCRYPTION_KEY);

    function verifiedRecord(overrides: Partial<KycVerification>) {
      kycVerificationRepo.findOneBy.mockResolvedValue({
        userId: 'user-1',
        bvnHash: null,
        ninHash: null,
        livenessVerified: false,
        ...overrides,
      } as KycVerification);
    }

    it.each([
      ['BVN', 'bvnHash', 'verifyBvn'],
      ['NIN', 'ninHash', 'verifyNin'],
    ] as const)(
      'returns the current state for the same %s without a provider call or attempt',
      async (_label, hashField, method) => {
        usersService.getKycTier.mockResolvedValue('tier1');
        verifiedRecord({ [hashField]: hmacHex('12345678901', key) });

        const result = await service[method]('user-1', '12345678901');

        expect(result).toEqual({
          tier: 'tier1',
          bvnVerified: hashField === 'bvnHash',
          ninVerified: hashField === 'ninHash',
          livenessVerified: false,
          livenessResult: 'not_requested',
        });
        expect(kycProvider.verifyBvn).not.toHaveBeenCalled();
        expect(kycProvider.verifyNin).not.toHaveBeenCalled();
        expect(attemptRepo.save).not.toHaveBeenCalled();
        expect(kycVerificationRepo.save).not.toHaveBeenCalled();
        expect(usersService.setKycTier).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['BVN', 'bvnHash', 'verifyBvn', BvnAlreadyVerifiedException],
      ['NIN', 'ninHash', 'verifyNin', NinAlreadyVerifiedException],
    ] as const)(
      'rejects a different %s before the provider, leaving data and attempts untouched',
      async (_label, hashField, method, errorClass) => {
        verifiedRecord({ [hashField]: hmacHex('12345678901', key) });

        await expect(service[method]('user-1', '99999999999')).rejects.toThrow(
          errorClass,
        );

        expect(kycProvider.verifyBvn).not.toHaveBeenCalled();
        expect(kycProvider.verifyNin).not.toHaveBeenCalled();
        expect(attemptRepo.save).not.toHaveBeenCalled();
        expect(kycVerificationRepo.save).not.toHaveBeenCalled();
      },
    );

    it('does not let a verified BVN block a first NIN, or the reverse', async () => {
      verifiedRecord({
        bvnHash: hmacHex('12345678901', key),
        identity: { bvn: { legalName: 'Ada Lovelace' } },
      });
      usersService.getKycTier.mockResolvedValue('tier1');
      await expect(
        service.verifyNin('user-1', '22222222222'),
      ).resolves.toMatchObject({ tier: 'tier2', ninVerified: true });

      verifiedRecord({
        ninHash: hmacHex('22222222222', key),
        identity: { nin: { legalName: 'Ada Lovelace' } },
      });
      await expect(
        service.verifyBvn('user-1', '12345678901'),
      ).resolves.toMatchObject({ tier: 'tier2', bvnVerified: true });
    });
  });

  describe('verified legal name', () => {
    function existing(name: string | null, bvnHash: string | null) {
      kycVerificationRepo.findOneBy.mockResolvedValue({
        userId: 'user-1',
        bvnHash,
        ninHash: null,
        verifiedLegalName: name,
        identity: bvnHash ? { bvn: { legalName: name ?? undefined } } : null,
        livenessVerified: false,
      } as KycVerification);
    }

    it('replaces a NIN-sourced name with the BVN name', async () => {
      existing('Nin Name', null);
      kycProvider.verifyBvn.mockResolvedValue({
        ...verifiedResult(),
        legalName: 'Bvn Name',
      });

      await service.verifyBvn('user-1', '12345678901');

      expect(kycVerificationRepo.save.mock.calls[0][0].verifiedLegalName).toBe(
        'Bvn Name',
      );
    });

    it('keeps the BVN name when a NIN is verified afterwards', async () => {
      existing('Ada Obi Lovelace', 'bvn-hash');
      kycProvider.verifyNin.mockResolvedValue({
        ...verifiedResult(),
        legalName: 'Lovelace Ada',
      });

      await service.verifyNin('user-1', '12345678901');

      expect(kycVerificationRepo.save.mock.calls[0][0].verifiedLegalName).toBe(
        'Ada Obi Lovelace',
      );
    });

    it('uses the NIN name while no BVN is verified', async () => {
      kycProvider.verifyNin.mockResolvedValue({
        ...verifiedResult(),
        legalName: 'Nin Name',
      });

      await service.verifyNin('user-1', '12345678901');

      expect(kycVerificationRepo.save.mock.calls[0][0].verifiedLegalName).toBe(
        'Nin Name',
      );
    });

    it('does not null an existing name when a NIN lookup returns none', async () => {
      existing('Nin Name', null);
      kycProvider.verifyNin.mockResolvedValue({
        status: 'verified',
      });

      await service.verifyNin('user-1', '12345678901');

      expect(kycVerificationRepo.save.mock.calls[0][0].verifiedLegalName).toBe(
        'Nin Name',
      );
    });

    it('does not null an existing name when a BVN lookup returns none', async () => {
      existing('Nin Name', null);
      kycProvider.verifyBvn.mockResolvedValue({ status: 'verified' });

      await service.verifyBvn('user-1', '12345678901');

      expect(kycVerificationRepo.save.mock.calls[0][0].verifiedLegalName).toBe(
        'Nin Name',
      );
    });
  });

  describe('verifyNin', () => {
    const bvnAddress = {
      street: '3 Bvn St',
      town: 'Surulere',
      lga: 'Surulere',
      state: 'Lagos',
    };

    it('stores the NIN under the nin keys and merges the address without touching bvn', async () => {
      kycVerificationRepo.findOneBy.mockResolvedValue({
        userId: 'user-1',
        bvnHash: 'bvn-hash',
        identity: { bvn: { legalName: 'Ada Lovelace' } },
        livenessVerified: false,
        address: { bvn: bvnAddress },
      } as KycVerification);
      usersService.getKycTier.mockResolvedValue('tier1');

      const result = await service.verifyNin('user-1', '12345678901');

      const saved = kycVerificationRepo.save.mock.calls[0][0];
      expect(typeof saved.ninHash).toBe('string');
      expect(typeof saved.ninCiphertext).toBe('string');
      expect(saved.bvnHash).toBe('bvn-hash');
      expect(saved.address).toEqual({
        bvn: bvnAddress,
        nin: verifiedResult().address,
      });
      expect(attemptRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ identityType: 'nin' }),
      );
      expect(usersService.setKycTier).toHaveBeenCalledWith(
        fakeManager,
        'user-1',
        'tier2',
      );
      expect(result).toEqual({
        tier: 'tier2',
        bvnVerified: true,
        ninVerified: true,
        livenessVerified: false,
        livenessResult: 'not_requested',
      });
    });

    it('upgrades a tier0 user to tier1 when no BVN is verified yet', async () => {
      const result = await service.verifyNin('user-1', '12345678901');

      expect(usersService.setKycTier).toHaveBeenCalledWith(
        fakeManager,
        'user-1',
        'tier1',
      );
      expect(result).toMatchObject({
        tier: 'tier1',
        bvnVerified: false,
        ninVerified: true,
      });
    });

    it('does not call setKycTier when the derived tier does not increase', async () => {
      usersService.getKycTier.mockResolvedValue('tier2');
      kycVerificationRepo.findOneBy.mockResolvedValue({
        userId: 'user-1',
        bvnHash: 'bvn-hash',
        identity: { bvn: { legalName: 'Ada Lovelace' } },
        livenessVerified: false,
      } as KycVerification);

      const result = await service.verifyNin('user-1', '12345678901');

      expect(usersService.setKycTier).not.toHaveBeenCalled();
      expect(result.tier).toBe('tier2');
    });

    it('keeps the attempt counted as failed and persists nothing when the provider does not verify', async () => {
      kycProvider.verifyNin.mockResolvedValue({ status: 'mismatch' });

      await expect(service.verifyNin('user-1', '11110000000')).rejects.toThrow(
        NinVerificationFailedException,
      );
      expect(attemptRepo.delete).not.toHaveBeenCalled();
      expect(kycVerificationRepo.save).not.toHaveBeenCalled();
      expect(kycProvider.verifyBvn).not.toHaveBeenCalled();
    });

    it('releases the reserved attempt when the provider itself errors', async () => {
      kycProvider.verifyNin.mockRejectedValue(new Error('provider down'));

      await expect(service.verifyNin('user-1', '12345678901')).rejects.toThrow(
        'provider down',
      );
      expect(attemptRepo.delete).toHaveBeenCalledWith({ id: 'attempt-1' });
    });

    it('maps a nin_hash unique violation to a conflict error', async () => {
      kycVerificationRepo.save.mockRejectedValue(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'UQ_kyc_verifications_nin_hash_partial',
        }),
      );

      await expect(service.verifyNin('user-1', '12345678901')).rejects.toThrow(
        NinAlreadyLinkedException,
      );
      expect(attemptRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('same-person check between BVN and NIN', () => {
    function stored(overrides: Partial<KycVerification>) {
      kycVerificationRepo.findOneBy.mockResolvedValue({
        userId: 'user-1',
        bvnHash: null,
        ninHash: null,
        livenessVerified: false,
        ...overrides,
      } as KycVerification);
    }

    function expectNothingWritten() {
      expect(kycVerificationRepo.save).not.toHaveBeenCalled();
      expect(usersService.setKycTier).not.toHaveBeenCalled();
      expect(attemptRepo.update).not.toHaveBeenCalled();
      expect(attemptRepo.delete).not.toHaveBeenCalled();
    }

    it('rejects a NIN that belongs to a different person than the verified BVN, leaving the attempt counted as failed', async () => {
      stored({
        bvnHash: 'bvn-hash',
        identity: { bvn: { legalName: 'Grace Hopper' } },
      });

      await expect(service.verifyNin('user-1', '12345678901')).rejects.toThrow(
        IdentityMismatchException,
      );
      expect(attemptRepo.save).toHaveBeenCalledTimes(1);
      expectNothingWritten();
    });

    it('rejects a BVN that belongs to a different person than the verified NIN', async () => {
      stored({
        ninHash: 'nin-hash',
        identity: { nin: { legalName: 'Grace Hopper' } },
      });

      await expect(service.verifyBvn('user-1', '12345678901')).rejects.toThrow(
        IdentityMismatchException,
      );
      expectNothingWritten();
    });

    it('rejects when the names match but the dates of birth differ', async () => {
      stored({
        bvnHash: 'bvn-hash',
        identity: {
          bvn: { legalName: 'Ada Lovelace', dateOfBirth: '1990-01-02' },
        },
      });
      kycProvider.verifyNin.mockResolvedValue({
        ...verifiedResult(),
        dateOfBirth: '1991-02-03',
      });

      await expect(service.verifyNin('user-1', '12345678901')).rejects.toThrow(
        IdentityMismatchException,
      );
      expectNothingWritten();
    });

    it('fails closed when the stored identifier has no name to compare', async () => {
      stored({ bvnHash: 'bvn-hash', identity: { bvn: {} } });

      await expect(service.verifyNin('user-1', '12345678901')).rejects.toThrow(
        IdentityMismatchException,
      );
    });

    it('accepts a matching identifier and records each source separately', async () => {
      stored({
        bvnHash: 'bvn-hash',
        identity: {
          bvn: { legalName: 'Ada Obi Lovelace', dateOfBirth: '1990-01-02' },
        },
      });
      kycProvider.verifyNin.mockResolvedValue({
        ...verifiedResult(),
        legalName: 'Lovelace Ada',
        dateOfBirth: '1990-01-02',
      });

      await service.verifyNin('user-1', '12345678901');

      expect(kycVerificationRepo.save.mock.calls[0][0].identity).toEqual({
        bvn: { legalName: 'Ada Obi Lovelace', dateOfBirth: '1990-01-02' },
        nin: { legalName: 'Lovelace Ada', dateOfBirth: '1990-01-02' },
      });
    });

    it('does not compare anything for the first identifier', async () => {
      await service.verifyBvn('user-1', '12345678901');

      expect(kycVerificationRepo.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('liveness', () => {
    const key = encryptionKeyFromHex(TEST_ENCRYPTION_KEY);
    const liveness: LivenessCaptureDto = {
      selfieImage: '/9j/AA==',
      livenessImages: Array<string>(6).fill('/9j/AA=='),
      consentGranted: true,
    };

    beforeEach(() => {
      jobRepo.findOneBy.mockResolvedValue({
        id: 'job-1',
        userId: 'user-1',
        attemptId: 'attempt-1',
        status: 'pending',
      } as KycLivenessJob);
    });

    function bvnVerifiedRecord(overrides: Partial<KycVerification> = {}) {
      kycVerificationRepo.findOneBy.mockResolvedValue({
        userId: 'user-1',
        bvnHash: hmacHex('12345678901', key),
        bvnCiphertext: 'cipher',
        identity: { bvn: { legalName: 'Ada Lovelace' } },
        ninHash: null,
        livenessVerified: false,
        ...overrides,
      } as KycVerification);
    }

    it('persists identity, passes liveness synchronously and only then marks the attempt successful', async () => {
      const result = await service.verifyBvn('user-1', '12345678901', liveness);

      expect(kycProvider.submitLiveness).toHaveBeenCalledWith(
        expect.objectContaining({
          idType: 'bvn',
          idNumber: '12345678901',
          selfieImage: liveness.selfieImage,
          livenessImages: liveness.livenessImages,
          user: {
            givenNames: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
            phone: '+2348000000000',
          },
        }),
      );
      expect(attemptRepo.update).toHaveBeenCalledTimes(1);
      expect(attemptRepo.update).toHaveBeenCalledWith(
        { id: 'attempt-1' },
        { succeeded: true },
      );
      expect(jobRepo.update).toHaveBeenCalledWith(
        { id: 'job-1' },
        { status: 'passed' },
      );
      expect(result).toMatchObject({
        livenessVerified: true,
        livenessResult: 'passed',
      });
    });

    it('keeps a verified identity but leaves the attempt failed when liveness fails', async () => {
      kycProvider.submitLiveness.mockResolvedValue({ status: 'failed' });

      const result = await service.verifyBvn('user-1', '12345678901', liveness);

      expect(kycVerificationRepo.save).toHaveBeenCalledTimes(1);
      expect(attemptRepo.update).not.toHaveBeenCalled();
      expect(usersService.setKycTier).toHaveBeenCalledWith(
        fakeManager,
        'user-1',
        'tier1',
      );
      expect(result).toEqual({
        tier: 'tier1',
        bvnVerified: true,
        ninVerified: false,
        livenessVerified: false,
        livenessResult: 'failed',
      });
    });

    it('records the provider job id and reports pending when the provider is asynchronous', async () => {
      kycProvider.submitLiveness.mockResolvedValue({
        status: 'pending',
        jobId: 'provider-job-1',
      });

      const result = await service.verifyBvn('user-1', '12345678901', liveness);

      expect(jobRepo.update).toHaveBeenCalledWith(
        { id: 'job-1' },
        { providerJobId: 'provider-job-1' },
      );
      expect(attemptRepo.update).not.toHaveBeenCalled();
      expect(result.livenessResult).toBe('pending');
      expect(result.livenessVerified).toBe(false);
    });

    it('attaches liveness to an already-verified identity without rewriting identity fields', async () => {
      bvnVerifiedRecord({ verifiedLegalName: 'Stored Name' });

      const result = await service.verifyBvn('user-1', '12345678901', liveness);

      expect(kycProvider.verifyBvn).not.toHaveBeenCalled();
      expect(kycVerificationRepo.save).toHaveBeenCalledTimes(1);
      expect(kycVerificationRepo.save.mock.calls[0][0]).toMatchObject({
        bvnCiphertext: 'cipher',
        verifiedLegalName: 'Stored Name',
        livenessVerified: true,
      });
      expect(result.livenessResult).toBe('passed');
    });

    it('is a free no-op when liveness is already verified, even with a selfie', async () => {
      bvnVerifiedRecord({ livenessVerified: true });

      const result = await service.verifyBvn('user-1', '12345678901', liveness);

      expect(kycProvider.verifyBvn).not.toHaveBeenCalled();
      expect(kycProvider.submitLiveness).not.toHaveBeenCalled();
      expect(attemptRepo.save).not.toHaveBeenCalled();
      expect(result.livenessResult).toBe('passed');
    });

    it('skips the liveness call on a first-time identity when liveness is already verified', async () => {
      bvnVerifiedRecord({ livenessVerified: true });

      const result = await service.verifyNin('user-1', '22222222222', liveness);

      expect(kycProvider.submitLiveness).not.toHaveBeenCalled();
      expect(attemptRepo.update).toHaveBeenCalledWith(
        { id: 'attempt-1' },
        { succeeded: true },
      );
      expect(result.livenessResult).toBe('passed');
    });

    it('still rejects a different identifier with a selfie', async () => {
      bvnVerifiedRecord();

      await expect(
        service.verifyBvn('user-1', '99999999999', liveness),
      ).rejects.toThrow(BvnAlreadyVerifiedException);
      expect(kycProvider.submitLiveness).not.toHaveBeenCalled();
      expect(attemptRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a selfie while another liveness job is pending, before any provider call', async () => {
      jobRepo.countBy.mockResolvedValue(1);

      await expect(
        service.verifyBvn('user-1', '12345678901', liveness),
      ).rejects.toThrow(LivenessInProgressException);
      expect(kycProvider.verifyBvn).not.toHaveBeenCalled();
      expect(attemptRepo.save).not.toHaveBeenCalled();
    });

    it('counts repeated selfie retries on a verified identifier toward the rate limit', async () => {
      bvnVerifiedRecord();
      attemptRepo.count.mockResolvedValue(5);

      await expect(
        service.verifyBvn('user-1', '12345678901', liveness),
      ).rejects.toThrow(TooManyVerificationAttemptsException);
      expect(kycProvider.submitLiveness).not.toHaveBeenCalled();
    });

    it('releases the reserved attempt when the liveness submission itself errors', async () => {
      kycProvider.submitLiveness.mockRejectedValue(new Error('provider down'));

      await expect(
        service.verifyBvn('user-1', '12345678901', liveness),
      ).rejects.toThrow('provider down');
      expect(attemptRepo.delete).toHaveBeenCalledWith({ id: 'attempt-1' });
    });

    it('does not carry the images into the stored attempt, job or verification rows', async () => {
      await service.verifyBvn('user-1', '12345678901', liveness);

      const written = JSON.stringify([
        kycVerificationRepo.save.mock.calls,
        attemptRepo.save.mock.calls,
        jobRepo.save.mock.calls,
        jobRepo.update.mock.calls,
      ]);
      expect(written).not.toContain(liveness.selfieImage);
    });

    function pendingJob(
      id: string,
      overrides: Partial<KycLivenessJob> = {},
    ): KycLivenessJob {
      return {
        id,
        userId: 'user-1',
        attemptId: `attempt-${id}`,
        providerJobId: `provider-${id}`,
        status: 'pending',
        pollFailures: 0,
        ...overrides,
      } as KycLivenessJob;
    }

    function nextPollFinds(expired: KycLivenessJob[], live: KycLivenessJob[]) {
      jobRepo.find.mockResolvedValueOnce(expired).mockResolvedValueOnce(live);
    }

    it('leaves a job pending and the attempt untouched when the provider status call throws, counting the failure', async () => {
      const job = pendingJob('job-1');
      nextPollFinds([], [job]);
      kycProvider.getLivenessResult.mockRejectedValue(new Error('503'));

      await service.pollPendingLivenessJobs();

      expect(jobRepo.update).not.toHaveBeenCalled();
      expect(attemptRepo.update).not.toHaveBeenCalled();
      expect(jobRepo.increment).toHaveBeenCalledWith(
        { id: 'job-1' },
        'pollFailures',
        1,
      );
    });

    it('only polls jobs that are unexpired and under the consecutive-failure cap', async () => {
      nextPollFinds([], []);

      await service.pollPendingLivenessJobs();

      const liveQuery = jobRepo.find.mock.calls[1][0] as {
        where: { pollFailures: unknown; createdAt: unknown };
      };
      expect(liveQuery.where.pollFailures).toBeDefined();
      expect(liveQuery.where.createdAt).toBeDefined();
    });

    it('resets the failure count after a successful pending answer', async () => {
      nextPollFinds([], [pendingJob('job-1', { pollFailures: 3 })]);
      kycProvider.getLivenessResult.mockResolvedValue('pending');

      await service.pollPendingLivenessJobs();

      expect(jobRepo.update).toHaveBeenCalledWith(
        { id: 'job-1' },
        { pollFailures: 0 },
      );
    });

    it('applies a verdict the provider reached before an expired job is given up on', async () => {
      const job = pendingJob('job-1');
      jobRepo.findOneBy.mockResolvedValue(job);
      bvnVerifiedRecord();
      nextPollFinds([job], []);
      kycProvider.getLivenessResult.mockResolvedValue('passed');

      await service.pollPendingLivenessJobs();

      expect(jobRepo.update).toHaveBeenCalledWith(
        { id: 'job-1' },
        { status: 'passed' },
      );
      expect(jobRepo.update).not.toHaveBeenCalledWith(
        { id: 'job-1', status: 'pending' },
        { status: 'failed' },
      );
    });

    it.each([
      ['still processing', () => Promise.resolve('pending' as const)],
      ['erroring', () => Promise.reject(new Error('503'))],
    ])(
      'fails an expired job whose final poll is %s',
      async (_label, answer) => {
        nextPollFinds([pendingJob('job-1')], []);
        kycProvider.getLivenessResult.mockImplementation(answer);

        await service.pollPendingLivenessJobs();

        expect(jobRepo.update).toHaveBeenCalledWith(
          { id: 'job-1', status: 'pending' },
          { status: 'failed' },
        );
        expect(attemptRepo.update).not.toHaveBeenCalled();
      },
    );

    it('fails an expired job that never got a provider job id without calling the provider', async () => {
      nextPollFinds([pendingJob('job-1', { providerJobId: null })], []);

      await service.pollPendingLivenessJobs();

      expect(kycProvider.getLivenessResult).not.toHaveBeenCalled();
      expect(jobRepo.update).toHaveBeenCalledWith(
        { id: 'job-1', status: 'pending' },
        { status: 'failed' },
      );
    });

    it('stops polling once the tick budget is spent and leaves the rest for the next tick', async () => {
      nextPollFinds(
        [],
        [pendingJob('job-1'), pendingJob('job-2'), pendingJob('job-3')],
      );
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      kycProvider.getLivenessResult.mockImplementation(() => {
        now += 40_000;
        return Promise.resolve('pending' as const);
      });

      try {
        await service.pollPendingLivenessJobs();
      } finally {
        jest.restoreAllMocks();
      }

      expect(kycProvider.getLivenessResult).toHaveBeenCalledTimes(2);
    });

    it('ignores a webhook that names no pending job and never trusts its body', async () => {
      kycProvider.parseWebhookJobId.mockReturnValue(null);

      await service.handleLivenessWebhook({ status: 'clear' });

      expect(kycProvider.getLivenessResult).not.toHaveBeenCalled();
    });

    it('re-polls the provider for a job named by a webhook and applies the fetched outcome', async () => {
      kycProvider.parseWebhookJobId.mockReturnValue('provider-job-1');
      jobRepo.findOneBy.mockResolvedValue({
        id: 'job-1',
        userId: 'user-1',
        attemptId: 'attempt-1',
        providerJobId: 'provider-job-1',
        status: 'pending',
      } as KycLivenessJob);
      kycProvider.getLivenessResult.mockResolvedValue('failed');

      await service.handleLivenessWebhook({ whatever: 'clear' });

      expect(kycProvider.getLivenessResult).toHaveBeenCalledWith(
        'provider-job-1',
      );
      expect(jobRepo.update).toHaveBeenCalledWith(
        { id: 'job-1' },
        { status: 'failed' },
      );
    });
  });

  describe('getStatus', () => {
    it('returns tier0 defaults and the tier0 limits when no verification row exists', async () => {
      const result = await service.getStatus('user-1');

      expect(result).toEqual({
        tier: 'tier0',
        bvnVerified: false,
        ninVerified: false,
        livenessVerified: false,
        livenessPending: false,
        dailyDebitLimit: { amount: '0', currency: 'NGN' },
        balanceCap: { amount: '0', currency: 'NGN' },
      });
    });

    it('reports a null balance cap for an uncapped tier', async () => {
      usersService.findById.mockResolvedValue({
        id: 'user-1',
        kycTier: 'tier3',
      });
      tierLimitRepo.findOneBy.mockResolvedValue({
        dailyDebitLimitMinor: 500_000_000n,
        balanceCapMinor: null,
      } as TierLimit);

      const result = await service.getStatus('user-1');

      expect(result.balanceCap).toBeNull();
      expect(result.dailyDebitLimit).toEqual({
        amount: '500000000',
        currency: 'NGN',
      });
    });

    it('reflects verified pieces from the kyc_verifications row', async () => {
      usersService.findById.mockResolvedValue({
        id: 'user-1',
        kycTier: 'tier1',
      });
      kycVerificationRepo.findOneBy.mockResolvedValue({
        bvnHash: 'hash',
        ninHash: null,
        livenessVerified: false,
      } as KycVerification);

      const result = await service.getStatus('user-1');

      expect(result).toEqual({
        tier: 'tier1',
        bvnVerified: true,
        ninVerified: false,
        livenessVerified: false,
        livenessPending: false,
        dailyDebitLimit: { amount: '5000000', currency: 'NGN' },
        balanceCap: { amount: '30000000', currency: 'NGN' },
      });
    });
  });
});
