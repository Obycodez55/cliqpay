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
    };
    managerQuery = jest
      .fn<Promise<unknown>, [string, unknown[]]>()
      .mockResolvedValue(undefined);
    const getRepositoryMock = jest.fn((entity: unknown) => {
      if (entity === KycVerification) return kycVerificationRepo;
      if (entity === KycVerificationAttempt) return attemptRepo;
      if (entity === KycLivenessJob) return jobRepo;
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
      verifiedRecord({ bvnHash: hmacHex('12345678901', key) });
      usersService.getKycTier.mockResolvedValue('tier1');
      await expect(
        service.verifyNin('user-1', '22222222222'),
      ).resolves.toMatchObject({ tier: 'tier2', ninVerified: true });

      verifiedRecord({ ninHash: hmacHex('22222222222', key) });
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
      existing('Bvn Name', 'bvn-hash');
      kycProvider.verifyNin.mockResolvedValue({
        ...verifiedResult(),
        legalName: 'Nin Name',
      });

      await service.verifyNin('user-1', '12345678901');

      expect(kycVerificationRepo.save.mock.calls[0][0].verifiedLegalName).toBe(
        'Bvn Name',
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

    it('leaves a job pending and the attempt untouched when the provider status call throws', async () => {
      jobRepo.find.mockResolvedValue([
        {
          id: 'job-1',
          userId: 'user-1',
          attemptId: 'attempt-1',
          providerJobId: 'provider-job-1',
          status: 'pending',
        } as KycLivenessJob,
      ]);
      kycProvider.getLivenessResult.mockRejectedValue(new Error('503'));

      await service.pollPendingLivenessJobs();

      expect(jobRepo.update).not.toHaveBeenCalledWith(
        { id: 'job-1' },
        expect.anything(),
      );
      expect(attemptRepo.update).not.toHaveBeenCalled();
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
    it('returns tier0 defaults with a 0 daily allowance placeholder when no verification row exists', async () => {
      const result = await service.getStatus('user-1');

      expect(result).toEqual({
        tier: 'tier0',
        bvnVerified: false,
        ninVerified: false,
        livenessVerified: false,
        livenessPending: false,
        dailyAllowanceRemainingMinor: 0,
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
        dailyAllowanceRemainingMinor: 0,
      });
    });
  });
});
