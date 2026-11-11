import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager, IsNull, Not } from 'typeorm';
import { runInTransaction } from '../../database/transaction.util';
import {
  DomainEventEnvelope,
  EMAIL_VERIFICATION_OTP_EVENT,
  EmailVerificationOtpEventPayload,
  PASSWORD_RESET_OTP_EVENT,
  PasswordResetOtpEventPayload,
  PHONE_VERIFICATION_OTP_EVENT,
  PhoneVerificationOtpEventPayload,
  SECURITY_ALERT_EVENT,
  SecurityAlertEventPayload,
  StepUpAction,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { LedgerService } from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { Credential } from './entities/credential.entity';
import { MfaChallenge } from './entities/mfa-challenge.entity';
import { Session } from './entities/session.entity';
import { TrustedDevice } from './entities/trusted-device.entity';
import { VerificationCode } from './entities/verification-code.entity';
import { RegisterDto } from './dto/register.dto';
import { UnlockAccountDto } from './dto/unlock-account.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangeEmailDto } from './dto/change-email.dto';
import { ConfirmChangeEmailDto } from './dto/confirm-change-email.dto';
import { ChangePhoneDto } from './dto/change-phone.dto';
import { ConfirmChangePhoneDto } from './dto/confirm-change-phone.dto';
import { EnrollTotpDto } from './dto/enroll-totp.dto';
import { EnrollTotpResponseDto } from './dto/enroll-totp-response.dto';
import { StepUpChallengeResponseDto } from './dto/step-up-challenge-response.dto';
import {
  RegisterResponseDto,
  toRegisterResponse,
} from './dto/register-response.dto';
import {
  EmailAlreadyVerifiedException,
  InvalidCredentialsException,
  MfaChallengeInvalidException,
  PhoneAlreadyVerifiedException,
  AccountNotSelfLockedException,
  UnlockRequiresPasswordResetException,
  VerificationCodeInvalidException,
  VerificationCodeRateLimitedException,
} from './internal/errors';
import { MfaService } from './mfa.service';
import { VerificationCodeService } from './verification-code.service';
import { TransactionPinService } from './transaction-pin.service';

const BCRYPT_SALT_ROUNDS = 10;
const DEFAULT_WALLET_CURRENCY = 'NGN';

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PHONE_VERIFICATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * The one exported surface of the auth module — see docs/architecture.md
 * §10. Covers registration, login (including the MFA/trusted-device fork —
 * see §3.8), session rotation/revocation, and lockout. Identity itself
 * (email/phone/username/name) lives in `users` (see ADR-0005) — this
 * service resolves a `userId` via UsersService wherever it needs one and
 * otherwise works entirely against its own `Credential`/`Session`/MFA
 * tables.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly ledgerService: LedgerService,
    private readonly eventBus: EventBusService,
    private readonly mfaService: MfaService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly transactionPinService: TransactionPinService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    const { user, wallet } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const user = await this.usersService.createUser(manager, {
          email: dto.email,
          phone: dto.phone,
          username: dto.username,
          firstName: dto.firstName,
          lastName: dto.lastName,
        });

        const credentialRepo = manager.getRepository(Credential);
        const credential = credentialRepo.create({
          userId: user.id,
          passwordHash,
          transactionPinHash: null,
        });
        await credentialRepo.save(credential);

        // Auto-enrolled, not a separate call
        await this.mfaService.enrollEmailMethod(manager, user.id);

        const wallet = await this.ledgerService.createUserWallet(
          manager,
          user.id,
          DEFAULT_WALLET_CURRENCY,
        );

        return { user, wallet };
      },
    );

    // Fire-and-forget, after the transaction commits — nothing gates on
    // emailVerifiedAt/phoneVerifiedAt, so a delivery hiccup shouldn't fail
    // the registration.
    const emailEvent = await this.buildEmailVerificationEvent(
      user.id,
      user.email,
    );
    await this.eventBus.publish(emailEvent);
    const phoneEvent = await this.buildPhoneVerificationEvent(
      user.id,
      user.phone,
    );
    await this.eventBus.publish(phoneEvent);

    return toRegisterResponse(user, wallet);
  }

  // Takes the target address directly, not a user object — reused by
  // changeEmail() to send to a *new*, not-yet-live address (see issue #9),
  // as well as register()/resendEmailVerification() sending to the current
  // one.
  private async buildEmailVerificationEvent(
    userId: string,
    email: string,
  ): Promise<DomainEventEnvelope<string, EmailVerificationOtpEventPayload>> {
    const { token, expiresAt } = await this.verificationCodeService.issue(
      userId,
      'email_verification',
      EMAIL_VERIFICATION_TTL_MS,
      'numeric',
    );

    return {
      name: EMAIL_VERIFICATION_OTP_EVENT,
      payload: {
        userId,
        email,
        code: token,
        expiresInMinutes: Math.round(
          (expiresAt.getTime() - Date.now()) / 60_000,
        ),
      },
      occurredAt: new Date(),
    };
  }

  async verifyEmail(token: string): Promise<void> {
    const { userId } = await this.verificationCodeService.consume(
      'email_verification',
      token,
    );
    await this.usersService.markEmailVerified(userId);
  }

  async resendEmailVerification(userId: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (user.emailVerifiedAt) {
      throw new EmailAlreadyVerifiedException();
    }
    await this.verificationCodeService.assertResendAllowed(
      userId,
      'email_verification',
    );

    // Synchronous/awaited — unlike register()'s automatic send, this is a
    // deliberate action the user is actively waiting on right now.
    const event = await this.buildEmailVerificationEvent(user.id, user.email);
    await this.eventBus.dispatchAndAwait(event);
  }

  // Takes the target number directly, not a user object — reused by
  // changePhone() to send to a *new*, not-yet-live number (see issue #10),
  // as well as register()/resendPhoneVerification() sending to the current
  // one. Mirrors buildEmailVerificationEvent's shape.
  private async buildPhoneVerificationEvent(
    userId: string,
    phone: string,
  ): Promise<DomainEventEnvelope<string, PhoneVerificationOtpEventPayload>> {
    const { token, expiresAt } = await this.verificationCodeService.issue(
      userId,
      'phone_verification',
      PHONE_VERIFICATION_TTL_MS,
      'numeric',
    );

    return {
      name: PHONE_VERIFICATION_OTP_EVENT,
      payload: {
        userId,
        phone,
        code: token,
        expiresInMinutes: Math.round(
          (expiresAt.getTime() - Date.now()) / 60_000,
        ),
      },
      occurredAt: new Date(),
    };
  }

  async verifyPhone(code: string): Promise<void> {
    const { userId } = await this.verificationCodeService.consume(
      'phone_verification',
      code,
    );
    await this.usersService.markPhoneVerified(userId);
  }

  async resendPhoneVerification(userId: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (user.phoneVerifiedAt) {
      throw new PhoneAlreadyVerifiedException();
    }
    await this.verificationCodeService.assertResendAllowed(
      userId,
      'phone_verification',
    );

    // Synchronous/awaited — unlike register()'s automatic send, this is a
    // deliberate action the user is actively waiting on right now.
    const event = await this.buildPhoneVerificationEvent(user.id, user.phone);
    await this.eventBus.dispatchAndAwait(event);
  }

  private async buildPasswordResetEvent(user: {
    id: string;
    email: string;
  }): Promise<DomainEventEnvelope<string, PasswordResetOtpEventPayload>> {
    const { token, expiresAt } = await this.verificationCodeService.issue(
      user.id,
      'password_reset',
      PASSWORD_RESET_TTL_MS,
      'numeric',
    );

    return {
      name: PASSWORD_RESET_OTP_EVENT,
      payload: {
        userId: user.id,
        email: user.email,
        code: token,
        expiresInMinutes: Math.round(
          (expiresAt.getTime() - Date.now()) / 60_000,
        ),
      },
      occurredAt: new Date(),
    };
  }

  // Always resolves the same way regardless of whether `email` belongs to
  // an account — including on the rate-limit path (see
  // VerificationCodeRateLimitedException below) — so the response itself
  // can never be used to enumerate accounts. Only a real delivery failure
  // from dispatchAndAwait (unreachable unless the user exists) propagates,
  // per the same "user is actively waiting on this" reasoning as
  // resend{Email,Phone}Verification.
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return;
    }

    try {
      await this.verificationCodeService.assertResendAllowed(
        user.id,
        'password_reset',
      );
    } catch (error) {
      if (error instanceof VerificationCodeRateLimitedException) {
        return;
      }
      throw error;
    }

    const event = await this.buildPasswordResetEvent(user);
    await this.eventBus.dispatchAndAwait(event);
  }

  // Single-use falls out of VerificationCodeService.consume's usedAt check
  // — reusing a spent token throws the same VerificationCodeInvalidException
  // as any other purpose.
  async completePasswordReset(
    token: string,
    newPassword: string,
    revokeOtherSessions: boolean,
  ): Promise<void> {
    const { userId } = await this.verificationCodeService.consume(
      'password_reset',
      token,
    );

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    await runInTransaction(this.dataSource, async (manager) => {
      await manager
        .getRepository(Credential)
        .update({ userId }, { passwordHash, passwordResetAt: new Date() });
      await this.usersService.startSecurityCooldown(
        manager,
        userId,
        'password_reset',
        { type: 'user', id: userId },
      );

      if (revokeOtherSessions) {
        // Unauthenticated flow — no session is "completing the request" to
        // exclude, so every session for the user is revoked.
        await manager
          .getRepository(Session)
          .update({ userId }, { status: 'revoked' });
      }
    });
  }

  // Step 1 of 2 for change-password (see docs/adr/0006 — 2 calls, not 3, per
  // issue #11: unlike change-email/phone there's no new value to deliver and
  // confirm, just the current password plus a live step-up proof).
  async initiatePasswordChangeStepUp(
    userId: string,
  ): Promise<StepUpChallengeResponseDto> {
    const user = await this.usersService.findById(userId);
    return this.mfaService.createStepUpChallenge(user, 'change_password');
  }

  // Step 2 of 2 — verifies the step-up challenge and the current password,
  // then changes the password immediately (no pending/confirm step — see
  // initiatePasswordChangeStepUp above).
  async changePassword(
    userId: string,
    sessionId: string,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const { userId: challengeUserId } = await this.mfaService.verifyChallenge(
      dto.challengeId,
      dto.code,
    );
    if (challengeUserId !== userId) {
      throw new MfaChallengeInvalidException();
    }

    const credential = await this.dataSource
      .getRepository(Credential)
      .findOneByOrFail({ userId });

    const passwordMatches = await bcrypt.compare(
      dto.currentPassword,
      credential.passwordHash,
    );
    if (!passwordMatches) {
      throw new InvalidCredentialsException();
    }

    credential.passwordHash = await bcrypt.hash(
      dto.newPassword,
      BCRYPT_SALT_ROUNDS,
    );
    await runInTransaction(this.dataSource, async (manager) => {
      await manager.getRepository(Credential).save(credential);
      await this.usersService.startSecurityCooldown(
        manager,
        userId,
        'password_changed',
        { type: 'user', id: userId },
      );

      if (dto.revokeOtherSessions) {
        await manager
          .getRepository(Session)
          .update(
            { userId, status: 'active', id: Not(sessionId) },
            { status: 'revoked' },
          );
      }
    });
  }

  // Step-up for TOTP enrollment (docs/architecture.md §3.8 lists "MFA
  // methods" directly among the changes step-up must gate, unconditionally
  // regardless of trusted-device status) — same shape as the change-email/
  // phone/password step-up flows below (docs/adr/0006).
  async initiateTotpEnrollStepUp(
    userId: string,
  ): Promise<StepUpChallengeResponseDto> {
    const user = await this.usersService.findById(userId);
    return this.mfaService.createStepUpChallenge(user, 'enroll_totp');
  }

  // Gates MfaService.enrollTotp behind the step-up challenge above — a
  // pending TOTP method can only be created here, so confirmTotp (which
  // only ever activates a method that already exists) doesn't need its own
  // separate step-up gate. Same caller-ownership check as changeEmail/
  // changePhone/changePassword: verifyChallenge isn't caller-scoped, so this
  // checks the returned userId itself and reuses the same exception the
  // method already throws for an invalid challenge.
  async enrollTotp(
    userId: string,
    dto: EnrollTotpDto,
  ): Promise<EnrollTotpResponseDto> {
    const { userId: challengeUserId } = await this.mfaService.verifyChallenge(
      dto.challengeId,
      dto.code,
    );
    if (challengeUserId !== userId) {
      throw new MfaChallengeInvalidException();
    }
    await this.usersService.assertNotSelfLocked(userId);
    return this.mfaService.enrollTotp(userId);
  }

  // Step 1 of 3 for change-email (see docs/adr/0006) — fires unconditionally,
  // regardless of trusted-device status (docs/architecture.md §3.8), unlike
  // login's challenge which a trusted device can skip. Caller submits the
  // returned challengeId+code to changeEmail() below.
  async initiateEmailChangeStepUp(
    userId: string,
  ): Promise<StepUpChallengeResponseDto> {
    const user = await this.usersService.findById(userId);
    return this.mfaService.createStepUpChallenge(user, 'change_email');
  }

  // Step 2 of 3 — verifies the step-up challenge, stashes newEmail as
  // pending (not live yet — see users.User.pendingEmail), sends a
  // verification code to it, and fire-and-forget alerts the *current*
  // email that a change is underway.
  async changeEmail(userId: string, dto: ChangeEmailDto): Promise<void> {
    const { userId: challengeUserId } = await this.mfaService.verifyChallenge(
      dto.challengeId,
      dto.code,
    );
    // verifyChallenge isn't caller-scoped (it wasn't built for an
    // already-authenticated caller — login's challenge/verify is pre-auth),
    // so this endpoint checks ownership itself. Same "invalid" exception the
    // method already throws for a wrong/expired challenge — no separate
    // exception type, no signal about whose challenge it actually was.
    if (challengeUserId !== userId) {
      throw new MfaChallengeInvalidException();
    }

    await this.usersService.assertNotSelfLocked(userId);

    // Same 60s/5-per-hour bound as every other email_verification send
    // (resendEmailVerification) — without it, a caller could repeatedly
    // target an arbitrary third-party address with this endpoint. Checked
    // before any state changes, so a rate-limited attempt has no side
    // effects.
    await this.verificationCodeService.assertResendAllowed(
      userId,
      'email_verification',
    );

    const user = await this.usersService.findById(userId);
    await this.usersService.setPendingEmail(userId, dto.newEmail);

    const event = await this.buildEmailVerificationEvent(userId, dto.newEmail);
    await this.eventBus.dispatchAndAwait(event);

    const alertOccurredAt = new Date();
    await this.eventBus.publish<string, SecurityAlertEventPayload>({
      name: SECURITY_ALERT_EVENT,
      payload: {
        userId,
        email: user.email,
        message: `We received a request to change the email on your account to ${dto.newEmail}. If this wasn't you, please secure your account immediately.`,
        occurredAt: alertOccurredAt.toISOString(),
      },
      occurredAt: alertOccurredAt,
    });
  }

  // Step 3 of 3 — only on a valid, unexpired, unused code does the email
  // actually change. `sessionId` is the caller's own session (from the
  // access token), excluded from revocation when revokeOtherSessions is
  // true — unlike completePasswordReset's unauthenticated "revoke all",
  // this flow knows exactly which session is asking.
  async confirmEmailChange(
    userId: string,
    sessionId: string,
    dto: ConfirmChangeEmailDto,
  ): Promise<void> {
    const { userId: codeUserId } = await this.verificationCodeService.consume(
      'email_verification',
      dto.code,
    );
    // Same caller-scoping reasoning as changeEmail() above — consume() isn't
    // scoped to a caller either.
    if (codeUserId !== userId) {
      throw new VerificationCodeInvalidException();
    }

    await runInTransaction(this.dataSource, async (manager) => {
      await this.usersService.assertNotSelfLocked(userId, manager);
      await this.usersService.confirmPendingEmail(userId, manager);
      await this.usersService.startSecurityCooldown(
        manager,
        userId,
        'email_changed',
        { type: 'user', id: userId },
      );

      if (dto.revokeOtherSessions) {
        await manager
          .getRepository(Session)
          .update(
            { userId, status: 'active', id: Not(sessionId) },
            { status: 'revoked' },
          );
      }
    });
  }

  // Step 1 of 3 for change-phone (see docs/adr/0006, issue #10) — same
  // step-up shape as change-email, sharing MfaService.createStepUpChallenge
  // directly rather than new MFA plumbing.
  async initiatePhoneChangeStepUp(
    userId: string,
  ): Promise<StepUpChallengeResponseDto> {
    const user = await this.usersService.findById(userId);
    return this.mfaService.createStepUpChallenge(user, 'change_phone');
  }

  // Step 2 of 3 — verifies the step-up challenge, stashes newPhone as
  // pending (not live yet — see users.User.pendingPhone), sends a numeric
  // OTP to it (reusing 'phone_verification', same as issue #6), and
  // fire-and-forget alerts the account. There's no SMS-based security-alert
  // channel in this codebase, and the account's email is unaffected by this
  // change, so the alert reuses SECURITY_ALERT_EVENT to the user's email
  // rather than adding a new SMS alert type for one caller.
  async changePhone(userId: string, dto: ChangePhoneDto): Promise<void> {
    const { userId: challengeUserId } = await this.mfaService.verifyChallenge(
      dto.challengeId,
      dto.code,
    );
    if (challengeUserId !== userId) {
      throw new MfaChallengeInvalidException();
    }

    await this.usersService.assertNotSelfLocked(userId);

    // Same 60s/5-per-hour bound as every other phone_verification send
    // (resendPhoneVerification) — SMS costs real money per send, so this
    // also bounds cost-abuse against an arbitrary third-party number.
    // Checked before any state changes, so a rate-limited attempt has no
    // side effects.
    await this.verificationCodeService.assertResendAllowed(
      userId,
      'phone_verification',
    );

    const user = await this.usersService.findById(userId);
    await this.usersService.setPendingPhone(userId, dto.newPhone);

    const event = await this.buildPhoneVerificationEvent(userId, dto.newPhone);
    await this.eventBus.dispatchAndAwait(event);

    const alertOccurredAt = new Date();
    await this.eventBus.publish<string, SecurityAlertEventPayload>({
      name: SECURITY_ALERT_EVENT,
      payload: {
        userId,
        email: user.email,
        message: `We received a request to change the phone number on your account to ${dto.newPhone}. If this wasn't you, please secure your account immediately.`,
        occurredAt: alertOccurredAt.toISOString(),
      },
      occurredAt: alertOccurredAt,
    });
  }

  // Step 3 of 3 — only on a valid, unexpired, unused code does the phone
  // number actually change. Same caller-scoping and session-revocation
  // shape as confirmEmailChange.
  async confirmPhoneChange(
    userId: string,
    sessionId: string,
    dto: ConfirmChangePhoneDto,
  ): Promise<void> {
    const { userId: codeUserId } = await this.verificationCodeService.consume(
      'phone_verification',
      dto.code,
    );
    if (codeUserId !== userId) {
      throw new VerificationCodeInvalidException();
    }

    await runInTransaction(this.dataSource, async (manager) => {
      await this.usersService.assertNotSelfLocked(userId, manager);
      await this.usersService.confirmPendingPhone(userId, manager);
      await this.usersService.startSecurityCooldown(
        manager,
        userId,
        'phone_changed',
        { type: 'user', id: userId },
      );

      if (dto.revokeOtherSessions) {
        await manager
          .getRepository(Session)
          .update(
            { userId, status: 'active', id: Not(sessionId) },
            { status: 'revoked' },
          );
      }
    });
  }

  // The only surface #22 (send-money) needs — delegates to
  // TransactionPinService so its lockout state stays the auth module's
  // single source of truth (see ADR-0009).
  async verifyTransactionPin(userId: string, pin: string): Promise<void> {
    return this.transactionPinService.verifyTransactionPin(userId, pin);
  }

  // Generic step-up, for peripheral/core callers outside this module that
  // need the same re-prove-MFA-on-an-authenticated-session mechanism
  // change-email/phone/password use (docs/adr/0006) without each growing
  // its own feature-named pair of methods here the way those three did.
  // First caller: withdrawals' bank-account save (issue #27, ADR-0014).
  // Return type is structural, matching MfaService.createStepUpChallenge's
  // own shape, rather than auth's StepUpChallengeResponseDto — that DTO
  // class lives under auth/dto and isn't an importable cross-module entry
  // point (docs/architecture.md §10); callers outside this module get the
  // same shape without needing to import anything from here to type it.
  async initiateStepUp(
    userId: string,
    action: StepUpAction,
  ): Promise<{
    challengeId: string;
    method: 'email' | 'totp';
    expiresAt: Date;
  }> {
    const user = await this.usersService.findById(userId);
    return this.mfaService.createStepUpChallenge(user, action);
  }

  // Verifies a step-up challenge was created for, and answered by, this
  // exact caller — same ownership check every other step-up consumer in
  // this file repeats (verifyChallenge itself isn't caller-scoped). Throws
  // rather than returning a boolean so a caller can't accidentally ignore
  // the result, same as every other step-up gate here.
  async verifyStepUp(
    userId: string,
    challengeId: string,
    code: string,
  ): Promise<void> {
    const { userId: challengeUserId } = await this.mfaService.verifyChallenge(
      challengeId,
      code,
    );
    if (challengeUserId !== userId) {
      throw new MfaChallengeInvalidException();
    }
  }

  async countUsersBoundToDevice(
    deviceId: string,
    since: Date,
  ): Promise<number> {
    const row = await this.dataSource
      .getRepository(TrustedDevice)
      .createQueryBuilder('device')
      .select('COUNT(DISTINCT device.userId)', 'count')
      .where('device.deviceId = :deviceId', { deviceId })
      .andWhere('device.createdAt >= :since', { since })
      .getRawOne<{ count: string }>();
    return Number(row?.count ?? 0);
  }

  // A reviewer restores an address the owner controls after verifying it out
  // of band. Everything that could still be waiting in the old address is
  // voided: sessions, trusted devices, unused codes and open MFA challenges.
  async recoverEmail(
    userId: string,
    newEmail: string,
    reviewerId: string,
  ): Promise<void> {
    await runInTransaction(this.dataSource, async (manager) => {
      await this.usersService.recoverEmail(manager, {
        userId,
        newEmail,
        reviewerId,
      });
      await this.revokeAllAccess(manager, userId);
    });
  }

  // Cuts off everything issued so far: sessions, trusted devices (revoking a
  // device revokes its key), unused verification codes and open MFA
  // challenges. The caller owns the transaction.
  async revokeAllAccess(
    manager: EntityManager,
    userId: string,
  ): Promise<{
    sessionsRevoked: number;
    devicesRevoked: number;
    codesVoided: number;
    challengesFailed: number;
  }> {
    const sessions = await manager
      .getRepository(Session)
      .update({ userId, status: 'active' }, { status: 'revoked' });
    const devices = await manager
      .getRepository(TrustedDevice)
      .update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
    const codes = await manager
      .getRepository(VerificationCode)
      .update({ userId, usedAt: IsNull() }, { usedAt: new Date() });
    const challenges = await manager
      .createQueryBuilder()
      .update(MfaChallenge)
      .set({ status: 'failed' })
      .where(
        `status = 'pending' AND method_id IN (SELECT id FROM mfa_methods WHERE user_id = :userId)`,
        { userId },
      )
      .execute();
    return {
      sessionsRevoked: sessions.affected ?? 0,
      devicesRevoked: devices.affected ?? 0,
      codesVoided: codes.affected ?? 0,
      challengesFailed: challenges.affected ?? 0,
    };
  }

  initiateUnlockStepUp(userId: string): Promise<StepUpChallengeResponseDto> {
    return this.initiateStepUp(userId, 'unlock_account');
  }

  // Needs a password reset completed after the lock (an emailed reset, not a
  // change from a session), then the step-up and the PIN. The reset is checked
  // again under the user's lock when the restriction is lifted.
  async unlock(userId: string, dto: UnlockAccountDto): Promise<void> {
    await this.assertPasswordResetAfterLock(this.dataSource.manager, userId);
    await this.verifyStepUp(userId, dto.challengeId, dto.code);
    await this.transactionPinService.verifyTransactionPin(userId, dto.pin);

    await runInTransaction(this.dataSource, async (manager) => {
      await this.usersService.lockUser(manager, userId);
      await this.assertPasswordResetAfterLock(manager, userId);
      await this.usersService.liftRestriction(manager, {
        userId,
        reason: 'self_lock',
        sourceId: userId,
        actor: { type: 'user', id: userId },
      });
    });
    await this.publishUnlockAlert(userId);
  }

  private async assertPasswordResetAfterLock(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const lock = await this.usersService.getOpenSelfLock(manager, userId);
    if (!lock) {
      throw new AccountNotSelfLockedException();
    }
    const credential = await manager
      .getRepository(Credential)
      .findOneByOrFail({ userId });
    if (
      !credential.passwordResetAt ||
      credential.passwordResetAt <= lock.createdAt
    ) {
      throw new UnlockRequiresPasswordResetException();
    }
  }

  private async publishUnlockAlert(userId: string): Promise<void> {
    try {
      const user = await this.usersService.findById(userId);
      const occurredAt = new Date();
      await this.eventBus.publish<string, SecurityAlertEventPayload>({
        name: SECURITY_ALERT_EVENT,
        payload: {
          userId,
          email: user.email,
          message:
            'Your account was unlocked after a password reset. If this wasn’t you, lock it again now.',
          occurredAt: occurredAt.toISOString(),
        },
        occurredAt,
      });
    } catch (error) {
      this.logger.error(
        `Account ${userId} unlocked, but publishing the security alert failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}
