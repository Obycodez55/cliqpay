import { DataSource } from 'typeorm';
import { DomainEventEnvelope } from '../../../shared/events/domain-events';
import { AuthService } from '../auth.service';
import { LedgerService } from '../../ledger/ledger.service';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Credential } from '../entities/credential.entity';
import { Session } from '../entities/session.entity';
import { UsersService } from '../../users/users.service';
import { VerificationPurpose } from '../entities/verification-code.entity';
import { VerificationCodeRateLimitedException } from '../internal/errors';
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

describe('AuthService — password reset', () => {
  let usersService: {
    findByEmail: jest.Mock<Promise<UserFixture | null>, [string]>;
  };
  let credentialRepo: {
    update: jest.Mock<
      Promise<unknown>,
      [Partial<Credential>, Partial<Credential>]
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
      findByEmail: jest.fn((_email: string) => Promise.resolve(buildUser())),
    };
    credentialRepo = {
      update: jest.fn(
        (_criteria: Partial<Credential>, _partial: Partial<Credential>) =>
          Promise.resolve(),
      ),
    };
    sessionRepo = {
      update: jest.fn(
        (_criteria: Partial<Session>, _partial: Partial<Session>) =>
          Promise.resolve(),
      ),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) =>
        entity === Session ? sessionRepo : credentialRepo,
      ),
    };
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

  describe('requestPasswordReset', () => {
    it('issues a code and dispatches an email for an existing user', async () => {
      await service.requestPasswordReset('ada@example.com');

      expect(usersService.findByEmail).toHaveBeenCalledWith('ada@example.com');
      expect(verificationCodeService.assertResendAllowed).toHaveBeenCalledWith(
        'user-1',
        'password_reset',
      );
      expect(verificationCodeService.issue).toHaveBeenCalledWith(
        'user-1',
        'password_reset',
        expect.any(Number),
        'numeric',
      );
      expect(eventBus.dispatchAndAwait).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'password_reset_otp' }),
      );
    });

    it('resolves without issuing or dispatching anything for a nonexistent email', async () => {
      usersService.findByEmail.mockResolvedValueOnce(null);

      await expect(
        service.requestPasswordReset('nobody@example.com'),
      ).resolves.toBeUndefined();
      expect(
        verificationCodeService.assertResendAllowed,
      ).not.toHaveBeenCalled();
      expect(verificationCodeService.issue).not.toHaveBeenCalled();
      expect(eventBus.dispatchAndAwait).not.toHaveBeenCalled();
    });

    it('resolves without dispatching when rate-limited, so the response stays identical either way', async () => {
      verificationCodeService.assertResendAllowed.mockRejectedValueOnce(
        new VerificationCodeRateLimitedException(30),
      );

      await expect(
        service.requestPasswordReset('ada@example.com'),
      ).resolves.toBeUndefined();
      expect(verificationCodeService.issue).not.toHaveBeenCalled();
      expect(eventBus.dispatchAndAwait).not.toHaveBeenCalled();
    });

    it('propagates a genuine delivery failure', async () => {
      const error = new Error('provider down');
      eventBus.dispatchAndAwait.mockRejectedValueOnce(error);

      await expect(
        service.requestPasswordReset('ada@example.com'),
      ).rejects.toBe(error);
    });

    it('propagates an unexpected error from assertResendAllowed', async () => {
      const error = new Error('unexpected');
      verificationCodeService.assertResendAllowed.mockRejectedValueOnce(error);

      await expect(
        service.requestPasswordReset('ada@example.com'),
      ).rejects.toBe(error);
    });
  });

  describe('completePasswordReset', () => {
    it('consumes the token and updates the credential password hash', async () => {
      await service.completePasswordReset(
        'some-token',
        'a-brand-new-passphrase',
        false,
      );

      expect(verificationCodeService.consume).toHaveBeenCalledWith(
        'password_reset',
        'some-token',
      );
      const [criteria, updatedFields] = credentialRepo.update.mock.calls[0];
      expect(criteria).toEqual({ userId: 'user-1' });
      expect(updatedFields.passwordHash).toEqual(expect.any(String));
      expect(updatedFields.passwordHash).not.toBe('a-brand-new-passphrase');
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });

    it('revokes every session for the user when revokeOtherSessions is true', async () => {
      await service.completePasswordReset(
        'some-token',
        'a-brand-new-passphrase',
        true,
      );

      expect(sessionRepo.update).toHaveBeenCalledWith(
        { userId: 'user-1' },
        { status: 'revoked' },
      );
    });

    it('leaves sessions untouched when revokeOtherSessions is false', async () => {
      await service.completePasswordReset(
        'some-token',
        'a-brand-new-passphrase',
        false,
      );

      expect(sessionRepo.update).not.toHaveBeenCalled();
    });

    it('propagates VerificationCodeService.consume rejecting an invalid/reused token without touching Credential or Session', async () => {
      const error = new Error('invalid');
      verificationCodeService.consume.mockRejectedValueOnce(error);

      await expect(
        service.completePasswordReset(
          'bad-token',
          'a-brand-new-passphrase',
          true,
        ),
      ).rejects.toBe(error);
      expect(credentialRepo.update).not.toHaveBeenCalled();
      expect(sessionRepo.update).not.toHaveBeenCalled();
    });
  });
});
