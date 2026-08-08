import { DataSource } from 'typeorm';
import { AppConfig } from '../../../config';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { TransactionPinService } from '../transaction-pin.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Credential } from '../entities/credential.entity';
import { UsersService } from '../../users/users.service';
import {
  InvalidTransactionPinException,
  MfaChallengeInvalidException,
  TransactionPinAlreadySetException,
  TransactionPinLockedException,
  TransactionPinNotSetException,
} from '../internal/errors';
import { MfaService } from '../mfa.service';
import {
  compareTransactionPin,
  hashTransactionPin,
} from '../internal/pin.util';

jest.mock('../internal/pin.util', () => ({
  hashTransactionPin: jest.fn(),
  compareTransactionPin: jest.fn(),
}));

const hashTransactionPinMock = hashTransactionPin as jest.Mock<
  Promise<string>,
  [string, string]
>;
const compareTransactionPinMock = compareTransactionPin as jest.Mock<
  Promise<boolean>,
  [string, string, string]
>;

interface UserFixture {
  id: string;
  email: string;
  phone: string;
}

function buildUser(overrides: Partial<UserFixture> = {}): UserFixture {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    phone: '+2348011100000',
    ...overrides,
  };
}

function buildCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    userId: 'user-1',
    transactionPinHash: 'existing-pin-hash',
    failedPinAttempts: 0,
    pinLockedUntil: null,
    ...overrides,
  } as Credential;
}

describe('TransactionPinService', () => {
  let usersService: {
    findById: jest.Mock<Promise<UserFixture>, [string]>;
  };
  let mfaService: {
    createStepUpChallenge: jest.Mock<
      Promise<{
        challengeId: string;
        method: 'email' | 'totp';
        expiresAt: Date;
      }>,
      [UserFixture]
    >;
    verifyChallenge: jest.Mock<Promise<{ userId: string }>, [string, string]>;
  };
  let eventBus: {
    publish: jest.Mock<Promise<void>, [DomainEventEnvelope<string, unknown>]>;
  };
  let credentialRepo: {
    findOneByOrFail: jest.Mock<Promise<Credential>, [Partial<Credential>]>;
    save: jest.Mock<Promise<Credential>, [Credential]>;
  };
  let dataSource: { getRepository: jest.Mock<unknown, [unknown]> };
  let service: TransactionPinService;

  beforeEach(() => {
    usersService = {
      findById: jest.fn((_userId: string) => Promise.resolve(buildUser())),
    };
    mfaService = {
      createStepUpChallenge: jest.fn((_user: UserFixture) =>
        Promise.resolve({
          challengeId: 'challenge-1',
          method: 'email' as const,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
      verifyChallenge: jest.fn((_challengeId: string, _code: string) =>
        Promise.resolve({ userId: 'user-1' }),
      ),
    };
    eventBus = {
      publish: jest.fn((_event: DomainEventEnvelope<string, unknown>) =>
        Promise.resolve(),
      ),
    };
    credentialRepo = {
      findOneByOrFail: jest.fn((_criteria: Partial<Credential>) =>
        Promise.resolve(buildCredential()),
      ),
      save: jest.fn((credential: Credential) => Promise.resolve(credential)),
    };
    dataSource = {
      getRepository: jest.fn((_entity: unknown) => credentialRepo),
    };

    hashTransactionPinMock.mockReset();
    hashTransactionPinMock.mockResolvedValue('new-pin-hash');
    compareTransactionPinMock.mockReset();
    compareTransactionPinMock.mockResolvedValue(true);

    service = new TransactionPinService(
      dataSource as unknown as DataSource,
      { transactionPin: { pepper: 'test-pepper' } } as unknown as AppConfig,
      usersService as unknown as UsersService,
      mfaService as unknown as MfaService,
      eventBus as unknown as EventBusService,
    );
  });

  describe('setTransactionPin', () => {
    const dto = { pin: '4837', challengeId: 'challenge-1', code: '123456' };

    it('sets the PIN when none exists yet', async () => {
      credentialRepo.findOneByOrFail.mockResolvedValueOnce(
        buildCredential({ transactionPinHash: null }),
      );

      await service.setTransactionPin('user-1', dto);

      expect(hashTransactionPinMock).toHaveBeenCalledWith(
        '4837',
        'test-pepper',
      );
      expect(credentialRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ transactionPinHash: 'new-pin-hash' }),
      );
    });

    it('rejects setting a PIN when one is already set', async () => {
      await expect(
        service.setTransactionPin('user-1', dto),
      ).rejects.toBeInstanceOf(TransactionPinAlreadySetException);
      expect(credentialRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a challenge that belongs to a different user', async () => {
      mfaService.verifyChallenge.mockResolvedValueOnce({
        userId: 'someone-else',
      });

      await expect(
        service.setTransactionPin('user-1', dto),
      ).rejects.toBeInstanceOf(MfaChallengeInvalidException);
      expect(credentialRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('changeTransactionPin', () => {
    const dto = {
      currentPin: '1357',
      newPin: '4837',
      challengeId: 'challenge-1',
      code: '123456',
    };

    it('verifies the current PIN and replaces it on success', async () => {
      await service.changeTransactionPin('user-1', dto);

      expect(compareTransactionPinMock).toHaveBeenCalledWith(
        '1357',
        'test-pepper',
        'existing-pin-hash',
      );
      expect(credentialRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ transactionPinHash: 'new-pin-hash' }),
      );
    });

    it('rejects the wrong current PIN, incrementing the failure count without changing the hash', async () => {
      compareTransactionPinMock.mockResolvedValueOnce(false);

      await expect(
        service.changeTransactionPin('user-1', dto),
      ).rejects.toBeInstanceOf(InvalidTransactionPinException);

      expect(credentialRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ failedPinAttempts: 1 }),
      );
      expect(hashTransactionPinMock).not.toHaveBeenCalled();
    });

    it('locks the PIN and publishes a security alert on the third wrong attempt', async () => {
      credentialRepo.findOneByOrFail.mockResolvedValueOnce(
        buildCredential({ failedPinAttempts: 2 }),
      );
      compareTransactionPinMock.mockResolvedValueOnce(false);

      await expect(
        service.changeTransactionPin('user-1', dto),
      ).rejects.toBeInstanceOf(InvalidTransactionPinException);

      const saved = credentialRepo.save.mock.calls[0][0];
      expect(saved.failedPinAttempts).toBe(3);
      expect(saved.pinLockedUntil).toBeInstanceOf(Date);
      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'security_alert' }),
      );
    });

    it('rejects while locked, without comparing the PIN', async () => {
      credentialRepo.findOneByOrFail.mockResolvedValueOnce(
        buildCredential({
          failedPinAttempts: 3,
          pinLockedUntil: new Date(Date.now() + 60_000),
        }),
      );

      await expect(
        service.changeTransactionPin('user-1', dto),
      ).rejects.toBeInstanceOf(TransactionPinLockedException);
      expect(compareTransactionPinMock).not.toHaveBeenCalled();
    });

    it('rejects when no PIN has been set yet', async () => {
      credentialRepo.findOneByOrFail.mockResolvedValueOnce(
        buildCredential({ transactionPinHash: null }),
      );

      await expect(
        service.changeTransactionPin('user-1', dto),
      ).rejects.toBeInstanceOf(TransactionPinNotSetException);
    });

    it('rejects a challenge that belongs to a different user, without touching the credential', async () => {
      mfaService.verifyChallenge.mockResolvedValueOnce({
        userId: 'someone-else',
      });

      await expect(
        service.changeTransactionPin('user-1', dto),
      ).rejects.toBeInstanceOf(MfaChallengeInvalidException);
      expect(credentialRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('resetTransactionPin', () => {
    const dto = { newPin: '4837', challengeId: 'challenge-1', code: '123456' };

    it('sets a new PIN and clears the lockout state even while locked', async () => {
      credentialRepo.findOneByOrFail.mockResolvedValueOnce(
        buildCredential({
          failedPinAttempts: 3,
          pinLockedUntil: new Date(Date.now() + 60_000),
        }),
      );

      await service.resetTransactionPin('user-1', dto);

      expect(credentialRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionPinHash: 'new-pin-hash',
          failedPinAttempts: 0,
          pinLockedUntil: null,
        }),
      );
    });

    it('rejects a challenge that belongs to a different user', async () => {
      mfaService.verifyChallenge.mockResolvedValueOnce({
        userId: 'someone-else',
      });

      await expect(
        service.resetTransactionPin('user-1', dto),
      ).rejects.toBeInstanceOf(MfaChallengeInvalidException);
      expect(credentialRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('verifyTransactionPin', () => {
    it('resolves on a correct PIN and resets the failure count', async () => {
      credentialRepo.findOneByOrFail.mockResolvedValueOnce(
        buildCredential({ failedPinAttempts: 2 }),
      );

      await service.verifyTransactionPin('user-1', '1357');

      expect(credentialRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ failedPinAttempts: 0, pinLockedUntil: null }),
      );
    });

    it('throws on an incorrect PIN', async () => {
      compareTransactionPinMock.mockResolvedValueOnce(false);

      await expect(
        service.verifyTransactionPin('user-1', '0000'),
      ).rejects.toBeInstanceOf(InvalidTransactionPinException);
    });

    it('throws once locked, independent of what happens to login/session state', async () => {
      credentialRepo.findOneByOrFail.mockResolvedValueOnce(
        buildCredential({
          failedPinAttempts: 3,
          pinLockedUntil: new Date(Date.now() + 60_000),
        }),
      );

      await expect(
        service.verifyTransactionPin('user-1', '1357'),
      ).rejects.toBeInstanceOf(TransactionPinLockedException);
    });
  });
});
