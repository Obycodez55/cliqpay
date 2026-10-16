import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../../config';
import { KycTier, UsersService } from '../../users/users.service';
import { KycService } from '../kyc.service';
import { KycVerification } from '../entities/kyc-verification.entity';
import { KycVerificationAttempt } from '../entities/kyc-verification-attempt.entity';
import {
  KycProvider,
  KycVerificationResult,
} from '../providers/kyc-provider.interface';
import {
  BvnAlreadyLinkedException,
  BvnVerificationFailedException,
  NinAlreadyLinkedException,
  NinVerificationFailedException,
  TooManyVerificationAttemptsException,
} from '../internal/errors';

type FakeKycVerificationRepo = {
  findOneBy: jest.Mock<
    Promise<KycVerification | null>,
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
  let kycProvider: jest.Mocked<Pick<KycProvider, 'verifyBvn' | 'verifyNin'>>;
  let usersService: {
    findById: jest.Mock<Promise<{ id: string; kycTier: KycTier }>, [string]>;
    getKycTier: jest.Mock<Promise<KycTier>, [EntityManager, string]>;
    setKycTier: jest.Mock<Promise<void>, [EntityManager, string, KycTier]>;
  };

  beforeEach(() => {
    kycVerificationRepo = {
      findOneBy: jest
        .fn<Promise<KycVerification | null>, [Partial<KycVerification>]>()
        .mockResolvedValue(null),
      create: jest.fn(
        (data: Partial<KycVerification>) => data as KycVerification,
      ),
      save: jest.fn((entity: KycVerification) => Promise.resolve(entity)),
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
    managerQuery = jest
      .fn<Promise<unknown>, [string, unknown[]]>()
      .mockResolvedValue(undefined);
    const getRepositoryMock = jest.fn((entity: unknown) => {
      if (entity === KycVerification) return kycVerificationRepo;
      if (entity === KycVerificationAttempt) return attemptRepo;
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
    };
    usersService = {
      findById: jest
        .fn<Promise<{ id: string; kycTier: KycTier }>, [string]>()
        .mockResolvedValue({ id: 'user-1', kycTier: 'tier0' }),
      getKycTier: jest
        .fn<Promise<KycTier>, [EntityManager, string]>()
        .mockResolvedValue('tier0'),
      setKycTier: jest
        .fn<Promise<void>, [EntityManager, string, KycTier]>()
        .mockResolvedValue(undefined),
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
      const [lockSql, lockArgs] = managerQuery.mock.calls[1];
      expect(lockSql).toContain('pg_advisory_xact_lock');
      expect(lockArgs).toEqual(['user-1']);
      expect(lockCalls[1]).toBeLessThan(
        kycVerificationRepo.findOneBy.mock.invocationCallOrder[0],
      );
      expect(lockCalls[1]).toBeLessThan(
        usersService.getKycTier.mock.invocationCallOrder[0],
      );
      expect(usersService.getKycTier).toHaveBeenCalledWith(
        fakeManager,
        'user-1',
      );
    });

    it('does not downgrade or re-call setKycTier for an already tier1+ user re-verifying', async () => {
      usersService.getKycTier.mockResolvedValue('tier1');
      kycVerificationRepo.findOneBy.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        bvnCiphertext: 'old',
        bvnHash: 'old-hash',
        ninCiphertext: null,
        ninHash: null,
        address: null,
        verifiedLegalName: null,
        livenessVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.verifyBvn('user-1', '12345678901');

      expect(usersService.setKycTier).not.toHaveBeenCalled();
      expect(result.tier).toBe('tier1');
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
        ninHash: 'old-nin-hash',
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

  describe('getStatus', () => {
    it('returns tier0 defaults with a 0 daily allowance placeholder when no verification row exists', async () => {
      const result = await service.getStatus('user-1');

      expect(result).toEqual({
        tier: 'tier0',
        bvnVerified: false,
        ninVerified: false,
        livenessVerified: false,
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
        dailyAllowanceRemainingMinor: 0,
      });
    });
  });
});
