import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../../config';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { AuthService } from '../auth.service';
import { LedgerService } from '../../ledger/ledger.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { User } from '../entities/user.entity';
import { VerificationPurpose } from '../entities/verification-code.entity';
import { EmailAlreadyVerifiedException } from '../internal/errors';
import { MfaService } from '../mfa.service';
import { VerificationCodeService } from '../verification-code.service';

function buildUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: 'user-1',
    email: 'ada@example.com',
    passwordHash: 'hashed-password',
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada_l',
    phone: '+2348012345678',
    transactionPinHash: null,
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    ...overrides,
  });
}

describe('AuthService — email verification', () => {
  let userRepo: {
    update: jest.Mock<Promise<unknown>, [string, Partial<User>]>;
    findOneByOrFail: jest.Mock<Promise<User>, [Partial<User>]>;
  };
  let dataSource: { getRepository: jest.Mock<unknown, unknown[]> };
  let eventBus: {
    dispatchAndAwait: jest.Mock<
      Promise<void>,
      [DomainEventEnvelope<string, unknown>, (number | undefined)?]
    >;
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
  let service: AuthService;

  beforeEach(() => {
    userRepo = {
      update: jest.fn((_id: string, _fields: Partial<User>) =>
        Promise.resolve(),
      ),
      findOneByOrFail: jest.fn((_where: Partial<User>) =>
        Promise.resolve(buildUser()),
      ),
    };
    dataSource = { getRepository: jest.fn(() => userRepo) };
    eventBus = {
      dispatchAndAwait: jest.fn(
        (_event: DomainEventEnvelope<string, unknown>) => Promise.resolve(),
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
      consume: jest.fn((_purpose: VerificationPurpose, _token: string) =>
        Promise.resolve({ userId: 'user-1' }),
      ),
      assertResendAllowed: jest.fn(
        (_userId: string, _purpose: VerificationPurpose) => Promise.resolve(),
      ),
    };
    service = new AuthService(
      dataSource as unknown as DataSource,
      {
        app: { emailVerificationUrl: 'http://localhost:3000/verify-email' },
      } as unknown as AppConfig,
      {} as LedgerService,
      { signAsync: jest.fn() } as unknown as JwtService,
      eventBus as unknown as EventBusService,
      {} as MfaService,
      verificationCodeService as unknown as VerificationCodeService,
    );
  });

  describe('verifyEmail', () => {
    it('consumes the token and sets emailVerifiedAt on the resolved user', async () => {
      await service.verifyEmail('some-token');

      expect(verificationCodeService.consume).toHaveBeenCalledWith(
        'email_verification',
        'some-token',
      );
      const [updatedId, updatedFields] = userRepo.update.mock.calls[0];
      expect(updatedId).toBe('user-1');
      expect(updatedFields.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('propagates VerificationCodeService.consume rejecting an invalid token without touching the user', async () => {
      const error = new Error('invalid');
      verificationCodeService.consume.mockRejectedValueOnce(error);

      await expect(service.verifyEmail('bad-token')).rejects.toBe(error);
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('resendEmailVerification', () => {
    it('issues a fresh code and dispatches another email for an unverified user', async () => {
      await service.resendEmailVerification('user-1');

      expect(verificationCodeService.assertResendAllowed).toHaveBeenCalledWith(
        'user-1',
        'email_verification',
      );
      expect(verificationCodeService.issue).toHaveBeenCalledWith(
        'user-1',
        'email_verification',
        expect.any(Number),
      );
      expect(eventBus.dispatchAndAwait).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'email_verification_otp' }),
      );
    });

    it('rejects an already-verified user without issuing a new code', async () => {
      userRepo.findOneByOrFail.mockResolvedValueOnce(
        buildUser({ emailVerifiedAt: new Date() }),
      );

      await expect(
        service.resendEmailVerification('user-1'),
      ).rejects.toBeInstanceOf(EmailAlreadyVerifiedException);
      expect(
        verificationCodeService.assertResendAllowed,
      ).not.toHaveBeenCalled();
      expect(verificationCodeService.issue).not.toHaveBeenCalled();
    });

    it('propagates the rate-limit rejection from VerificationCodeService.assertResendAllowed, without issuing a new code', async () => {
      const error = new Error('rate limited');
      verificationCodeService.assertResendAllowed.mockRejectedValueOnce(error);

      await expect(service.resendEmailVerification('user-1')).rejects.toBe(
        error,
      );
      expect(verificationCodeService.issue).not.toHaveBeenCalled();
    });
  });
});
