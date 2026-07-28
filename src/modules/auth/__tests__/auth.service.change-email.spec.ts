import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../../config';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { AuthService } from '../auth.service';
import { LedgerService } from '../../ledger/ledger.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Session } from '../entities/session.entity';
import { UsersService } from '../../users/users.service';
import { VerificationPurpose } from '../entities/verification-code.entity';
import {
  MfaChallengeInvalidException,
  VerificationCodeInvalidException,
} from '../internal/errors';
import { MfaService } from '../mfa.service';
import { VerificationCodeService } from '../verification-code.service';

// Structural, not `users.User` — same reasoning as the password-reset spec.
interface UserFixture {
  id: string;
  email: string;
}

function buildUser(overrides: Partial<UserFixture> = {}): UserFixture {
  return { id: 'user-1', email: 'ada@example.com', ...overrides };
}

describe('AuthService — change email', () => {
  let usersService: {
    findById: jest.Mock<Promise<UserFixture>, [string]>;
    setPendingEmail: jest.Mock<Promise<void>, [string, string]>;
    confirmPendingEmail: jest.Mock<Promise<UserFixture>, [string]>;
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
  let verificationCodeService: {
    issue: jest.Mock<
      Promise<{ token: string; expiresAt: Date }>,
      [string, VerificationPurpose, number]
    >;
    consume: jest.Mock<
      Promise<{ userId: string }>,
      [VerificationPurpose, string]
    >;
    assertResendAllowed: jest.Mock<
      Promise<void>,
      [string, VerificationPurpose]
    >;
  };
  let sessionRepo: {
    update: jest.Mock<Promise<unknown>, [Partial<Session>, Partial<Session>]>;
  };
  let dataSource: { getRepository: jest.Mock<unknown, [unknown]> };
  let eventBus: {
    dispatchAndAwait: jest.Mock<
      Promise<void>,
      [DomainEventEnvelope<string, unknown>, (number | undefined)?]
    >;
    publish: jest.Mock<Promise<void>, [DomainEventEnvelope<string, unknown>]>;
  };
  let service: AuthService;

  beforeEach(() => {
    usersService = {
      findById: jest.fn((_userId: string) => Promise.resolve(buildUser())),
      setPendingEmail: jest.fn((_userId: string, _newEmail: string) =>
        Promise.resolve(),
      ),
      confirmPendingEmail: jest.fn((_userId: string) =>
        Promise.resolve(buildUser()),
      ),
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
    verificationCodeService = {
      issue: jest.fn(
        (_userId: string, _purpose: VerificationPurpose, _ttlMs: number) =>
          Promise.resolve({
            token: 'raw-token',
            expiresAt: new Date(Date.now() + 60_000),
          }),
      ),
      consume: jest.fn((_purpose: VerificationPurpose, _code: string) =>
        Promise.resolve({ userId: 'user-1' }),
      ),
      assertResendAllowed: jest.fn(
        (_userId: string, _purpose: VerificationPurpose) => Promise.resolve(),
      ),
    };
    sessionRepo = {
      update: jest.fn(
        (_criteria: Partial<Session>, _partial: Partial<Session>) =>
          Promise.resolve(),
      ),
    };
    dataSource = {
      getRepository: jest.fn((_entity: unknown) => sessionRepo),
    };
    eventBus = {
      dispatchAndAwait: jest.fn(
        (_event: DomainEventEnvelope<string, unknown>) => Promise.resolve(),
      ),
      publish: jest.fn((_event: DomainEventEnvelope<string, unknown>) =>
        Promise.resolve(),
      ),
    };
    service = new AuthService(
      dataSource as unknown as DataSource,
      {
        app: { emailVerificationUrl: 'http://localhost:3000/verify-email' },
      } as unknown as AppConfig,
      usersService as unknown as UsersService,
      {} as LedgerService,
      { signAsync: jest.fn() } as unknown as JwtService,
      eventBus as unknown as EventBusService,
      mfaService as unknown as MfaService,
      verificationCodeService as unknown as VerificationCodeService,
    );
  });

  describe('initiateEmailChangeStepUp', () => {
    it('loads the caller and creates a step-up challenge for them', async () => {
      const result = await service.initiateEmailChangeStepUp('user-1');

      expect(usersService.findById).toHaveBeenCalledWith('user-1');
      expect(mfaService.createStepUpChallenge).toHaveBeenCalledWith(
        buildUser(),
      );
      expect(result.challengeId).toBe('challenge-1');
      expect(result.method).toBe('email');
    });
  });

  describe('changeEmail', () => {
    const dto = {
      newEmail: 'ada-new@example.com',
      challengeId: 'challenge-1',
      code: '123456',
    };

    it('verifies the step-up challenge, stashes the pending email, and notifies both addresses', async () => {
      await service.changeEmail('user-1', dto);

      expect(mfaService.verifyChallenge).toHaveBeenCalledWith(
        'challenge-1',
        '123456',
      );
      expect(usersService.setPendingEmail).toHaveBeenCalledWith(
        'user-1',
        'ada-new@example.com',
      );
      expect(verificationCodeService.issue).toHaveBeenCalledWith(
        'user-1',
        'email_verification',
        expect.any(Number),
      );
      const [dispatchedEvent] = eventBus.dispatchAndAwait.mock.calls[0];
      expect(dispatchedEvent.name).toBe('email_verification_otp');
      expect(dispatchedEvent.payload).toMatchObject({
        email: 'ada-new@example.com',
      });

      const [publishedEvent] = eventBus.publish.mock.calls[0];
      expect(publishedEvent.name).toBe('security_alert');
      expect(publishedEvent.payload).toMatchObject({
        userId: 'user-1',
        email: 'ada@example.com',
      });
    });

    it('rejects a challenge that belongs to a different user, without stashing anything', async () => {
      mfaService.verifyChallenge.mockResolvedValueOnce({
        userId: 'someone-else',
      });

      await expect(service.changeEmail('user-1', dto)).rejects.toBeInstanceOf(
        MfaChallengeInvalidException,
      );
      expect(usersService.setPendingEmail).not.toHaveBeenCalled();
      expect(eventBus.dispatchAndAwait).not.toHaveBeenCalled();
      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('propagates a wrong/expired step-up challenge without stashing anything', async () => {
      const error = new MfaChallengeInvalidException();
      mfaService.verifyChallenge.mockRejectedValueOnce(error);

      await expect(service.changeEmail('user-1', dto)).rejects.toBe(error);
      expect(usersService.setPendingEmail).not.toHaveBeenCalled();
    });
  });

  describe('confirmEmailChange', () => {
    it('consumes the code and confirms the pending email, leaving sessions untouched by default', async () => {
      await service.confirmEmailChange('user-1', 'session-1', {
        code: 'some-code',
        revokeOtherSessions: false,
      });

      expect(verificationCodeService.consume).toHaveBeenCalledWith(
        'email_verification',
        'some-code',
      );
      expect(usersService.confirmPendingEmail).toHaveBeenCalledWith('user-1');
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });

    it('revokes every other active session, excluding the caller’s own, when revokeOtherSessions is true', async () => {
      await service.confirmEmailChange('user-1', 'session-1', {
        code: 'some-code',
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

    it('rejects a code that belongs to a different user, without confirming anything', async () => {
      verificationCodeService.consume.mockResolvedValueOnce({
        userId: 'someone-else',
      });

      await expect(
        service.confirmEmailChange('user-1', 'session-1', {
          code: 'some-code',
          revokeOtherSessions: false,
        }),
      ).rejects.toBeInstanceOf(VerificationCodeInvalidException);
      expect(usersService.confirmPendingEmail).not.toHaveBeenCalled();
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });

    it('propagates an invalid/expired/reused code without confirming anything', async () => {
      const error = new VerificationCodeInvalidException();
      verificationCodeService.consume.mockRejectedValueOnce(error);

      await expect(
        service.confirmEmailChange('user-1', 'session-1', {
          code: 'bad-code',
          revokeOtherSessions: true,
        }),
      ).rejects.toBe(error);
      expect(usersService.confirmPendingEmail).not.toHaveBeenCalled();
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });
  });
});
