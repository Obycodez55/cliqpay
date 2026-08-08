import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../../config';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { AuthService } from '../auth.service';
import { LedgerService } from '../../ledger/ledger.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Credential } from '../entities/credential.entity';
import { Session } from '../entities/session.entity';
import { UsersService } from '../../users/users.service';
import {
  InvalidCredentialsException,
  MfaChallengeInvalidException,
} from '../internal/errors';
import { MfaService } from '../mfa.service';
import { VerificationCodeService } from '../verification-code.service';
import { TransactionPinService } from '../transaction-pin.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

const bcryptCompare = bcrypt.compare as jest.Mock<
  Promise<boolean>,
  [string, string]
>;
const bcryptHash = bcrypt.hash as jest.Mock<Promise<string>, [string, number]>;

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

describe('AuthService — change password', () => {
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
  let credentialRepo: {
    findOneByOrFail: jest.Mock<Promise<Credential>, [Partial<Credential>]>;
    save: jest.Mock<Promise<Credential>, [Credential]>;
  };
  let sessionRepo: {
    update: jest.Mock<Promise<unknown>, [Partial<Session>, Partial<Session>]>;
  };
  let dataSource: { getRepository: jest.Mock<unknown, [unknown]> };
  let service: AuthService;

  const existingHash = 'existing-hash';

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
    credentialRepo = {
      findOneByOrFail: jest.fn((_criteria: Partial<Credential>) =>
        Promise.resolve({
          userId: 'user-1',
          passwordHash: existingHash,
        } as Credential),
      ),
      save: jest.fn((credential: Credential) => Promise.resolve(credential)),
    };
    sessionRepo = {
      update: jest.fn(
        (_criteria: Partial<Session>, _partial: Partial<Session>) =>
          Promise.resolve(),
      ),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) =>
        entity === Credential ? credentialRepo : sessionRepo,
      ),
    };
    bcryptCompare.mockReset();
    bcryptCompare.mockImplementation((plain: string) =>
      Promise.resolve(plain === 'correct-current-password'),
    );
    bcryptHash.mockReset();
    bcryptHash.mockResolvedValue('new-hash');

    service = new AuthService(
      dataSource as unknown as DataSource,
      {} as unknown as AppConfig,
      usersService as unknown as UsersService,
      {} as LedgerService,
      {
        dispatchAndAwait: jest.fn(
          (_event: DomainEventEnvelope<string, unknown>) => Promise.resolve(),
        ),
        publish: jest.fn((_event: DomainEventEnvelope<string, unknown>) =>
          Promise.resolve(),
        ),
      } as unknown as EventBusService,
      mfaService as unknown as MfaService,
      {} as VerificationCodeService,
      {} as TransactionPinService,
    );
  });

  describe('initiatePasswordChangeStepUp', () => {
    it('loads the caller and creates a step-up challenge for them', async () => {
      const result = await service.initiatePasswordChangeStepUp('user-1');

      expect(usersService.findById).toHaveBeenCalledWith('user-1');
      expect(mfaService.createStepUpChallenge).toHaveBeenCalledWith(
        buildUser(),
      );
      expect(result.challengeId).toBe('challenge-1');
    });
  });

  describe('changePassword', () => {
    const dto = {
      currentPassword: 'correct-current-password',
      newPassword: 'a-new-strong-passphrase',
      challengeId: 'challenge-1',
      code: '123456',
    };

    it('verifies the step-up challenge and current password, then updates the hash', async () => {
      await service.changePassword('user-1', 'session-1', {
        ...dto,
        revokeOtherSessions: false,
      });

      expect(mfaService.verifyChallenge).toHaveBeenCalledWith(
        'challenge-1',
        '123456',
      );
      expect(bcrypt.compare).toHaveBeenCalledWith(
        'correct-current-password',
        existingHash,
      );
      expect(credentialRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: 'new-hash' }),
      );
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });

    it('rejects a challenge that belongs to a different user, without touching the credential', async () => {
      mfaService.verifyChallenge.mockResolvedValueOnce({
        userId: 'someone-else',
      });

      await expect(
        service.changePassword('user-1', 'session-1', {
          ...dto,
          revokeOtherSessions: false,
        }),
      ).rejects.toBeInstanceOf(MfaChallengeInvalidException);
      expect(credentialRepo.save).not.toHaveBeenCalled();
    });

    it('propagates a wrong/expired step-up challenge without touching the credential', async () => {
      const error = new MfaChallengeInvalidException();
      mfaService.verifyChallenge.mockRejectedValueOnce(error);

      await expect(
        service.changePassword('user-1', 'session-1', {
          ...dto,
          revokeOtherSessions: false,
        }),
      ).rejects.toBe(error);
      expect(credentialRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a wrong current password, without touching the credential', async () => {
      await expect(
        service.changePassword('user-1', 'session-1', {
          ...dto,
          currentPassword: 'wrong-password',
          revokeOtherSessions: false,
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
      expect(credentialRepo.save).not.toHaveBeenCalled();
    });

    it('revokes every other active session, excluding the caller’s own, when revokeOtherSessions is true', async () => {
      await service.changePassword('user-1', 'session-1', {
        ...dto,
        revokeOtherSessions: true,
      });

      expect(sessionRepo.update).toHaveBeenCalledTimes(1);
      const [criteria, update] = sessionRepo.update.mock.calls[0];
      expect(criteria).toMatchObject({ userId: 'user-1', status: 'active' });
      const idOperator = (
        criteria as unknown as { id: { type: string; value: string } }
      ).id;
      expect(idOperator.type).toBe('not');
      expect(idOperator.value).toBe('session-1');
      expect(update).toEqual({ status: 'revoked' });
    });
  });
});
