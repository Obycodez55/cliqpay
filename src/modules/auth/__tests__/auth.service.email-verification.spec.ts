import { DataSource } from 'typeorm';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { AuthService } from '../auth.service';
import { LedgerService } from '../../ledger/ledger.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { UsersService } from '../../users/users.service';
import { VerificationPurpose } from '../entities/verification-code.entity';
import { EmailAlreadyVerifiedException } from '../internal/errors';
import { MfaService } from '../mfa.service';
import { VerificationCodeService } from '../verification-code.service';
import { TransactionPinService } from '../transaction-pin.service';

// Structural, not `users.User` — auth's tests can't import another core
// module's entity (only its exported service), same reasoning as
// MfaService's own narrowed parameter types.
interface UserFixture {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  username: string;
  usernameChangedAt: Date | null;
  phone: string;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
}

function buildUser(overrides: Partial<UserFixture> = {}): UserFixture {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: 'ada_l',
    usernameChangedAt: null,
    phone: '+2348012345678',
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    ...overrides,
  };
}

describe('AuthService — email verification', () => {
  let usersService: {
    findById: jest.Mock<Promise<UserFixture>, [string]>;
    markEmailVerified: jest.Mock<Promise<void>, [string]>;
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
    usersService = {
      findById: jest.fn((_userId: string) => Promise.resolve(buildUser())),
      markEmailVerified: jest.fn((_userId: string) => Promise.resolve()),
    };
    dataSource = { getRepository: jest.fn((_entity: unknown) => undefined) };
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
      usersService as unknown as UsersService,
      {} as LedgerService,
      eventBus as unknown as EventBusService,
      {} as MfaService,
      verificationCodeService as unknown as VerificationCodeService,
      {} as TransactionPinService,
    );
  });

  describe('verifyEmail', () => {
    it('consumes the token and marks the resolved user as email-verified', async () => {
      await service.verifyEmail('some-token');

      expect(verificationCodeService.consume).toHaveBeenCalledWith(
        'email_verification',
        'some-token',
      );
      expect(usersService.markEmailVerified).toHaveBeenCalledWith('user-1');
    });

    it('propagates VerificationCodeService.consume rejecting an invalid token without touching the user', async () => {
      const error = new Error('invalid');
      verificationCodeService.consume.mockRejectedValueOnce(error);

      await expect(service.verifyEmail('bad-token')).rejects.toBe(error);
      expect(usersService.markEmailVerified).not.toHaveBeenCalled();
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
        'numeric',
      );
      expect(eventBus.dispatchAndAwait).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'email_verification_otp' }),
      );
    });

    it('rejects an already-verified user without issuing a new code', async () => {
      usersService.findById.mockResolvedValueOnce(
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
