import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { runInTransaction } from '../../database/transaction.util';
import {
  DomainEventEnvelope,
  EMAIL_VERIFICATION_OTP_EVENT,
  EmailVerificationOtpEventPayload,
  SECURITY_ALERT_EVENT,
  SecurityAlertEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { LedgerService } from '../ledger/ledger.service';
import { Session } from './entities/session.entity';
import { User } from './entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { VerifyMfaChallengeDto } from './dto/verify-mfa-challenge.dto';
import {
  RegisterResponseDto,
  toRegisterResponse,
} from './dto/register-response.dto';
import {
  TokenPairResponseDto,
  toTokenPairResponse,
} from './dto/token-pair-response.dto';
import {
  AccountLockedException,
  EmailAlreadyVerifiedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  SessionRevokedException,
  mapUsersUniqueViolation,
} from './internal/errors';
import { MfaService } from './mfa.service';
import { generateOpaqueToken, hashOpaqueToken } from './internal/secrets.util';
import { DeviceMetadata } from './internal/device-metadata.util';
import { VerificationCodeService } from './verification-code.service';

const BCRYPT_SALT_ROUNDS = 10;
const DEFAULT_WALLET_CURRENCY = 'NGN';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FAILED_LOGIN_ATTEMPTS = 5; // 5 failed login attempts
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The one exported surface of the auth module — see docs/architecture.md
 * §10. Covers registration, login (including the MFA/trusted-device fork —
 * see §3.8), session rotation/revocation, and lockout.
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly ledgerService: LedgerService,
    private readonly jwtService: JwtService,
    private readonly eventBus: EventBusService,
    private readonly mfaService: MfaService,
    private readonly verificationCodeService: VerificationCodeService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    const { user, wallet } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        const userRepo = manager.getRepository(User);
        const user = userRepo.create({
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          username: dto.username,
          phone: dto.phone,
        });

        try {
          await userRepo.save(user);
        } catch (error) {
          mapUsersUniqueViolation(error);
        }

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
    // emailVerifiedAt, so a delivery hiccup shouldn't fail the registration.
    const event = await this.buildEmailVerificationEvent(user);
    await this.eventBus.publish(event);

    return toRegisterResponse(user, wallet);
  }

  private async buildEmailVerificationEvent(
    user: User,
  ): Promise<DomainEventEnvelope<string, EmailVerificationOtpEventPayload>> {
    const { token, expiresAt } = await this.verificationCodeService.issue(
      user.id,
      'email_verification',
      EMAIL_VERIFICATION_TTL_MS,
    );

    const url = new URL(this.config.app.emailVerificationUrl);
    url.searchParams.set('token', token);

    return {
      name: EMAIL_VERIFICATION_OTP_EVENT,
      payload: {
        userId: user.id,
        email: user.email,
        verificationUrl: url.toString(),
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
    await this.dataSource
      .getRepository(User)
      .update(userId, { emailVerifiedAt: new Date() });
  }

  async resendEmailVerification(userId: string): Promise<void> {
    const user = await this.dataSource
      .getRepository(User)
      .findOneByOrFail({ id: userId });
    if (user.emailVerifiedAt) {
      throw new EmailAlreadyVerifiedException();
    }
    await this.verificationCodeService.assertResendAllowed(
      userId,
      'email_verification',
    );

    // Synchronous/awaited — unlike register()'s automatic send, this is a
    // deliberate action the user is actively waiting on right now.
    const event = await this.buildEmailVerificationEvent(user);
    await this.eventBus.dispatchAndAwait(event);
  }

  // `trustedDeviceToken` is the raw value from the cookie the controller
  // read, or null if none was presented — see docs/architecture.md §3.8.
  // `device` is required, not defaulted — Session.device is NOT NULL, so
  // every caller has to supply a real value rather than the service
  // silently making one up (see ADR-0003).
  async login(
    dto: LoginDto,
    trustedDeviceToken: string | null,
    device: DeviceMetadata,
  ): Promise<LoginResponseDto> {
    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOneBy({ email: dto.email });
    if (!user) {
      throw new InvalidCredentialsException();
    }

    const now = new Date();
    if (user.lockedUntil) {
      if (user.lockedUntil > now) {
        throw new AccountLockedException(user.lockedUntil);
      }
      // Lockout window has passed — this attempt gets a fresh count rather
      // than instantly re-locking on one more wrong guess.
      user.lockedUntil = null;
      user.failedLoginAttempts = 0;
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        user.lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
      }
      await userRepo.save(user);
      throw new InvalidCredentialsException();
    }

    // The password proved correct regardless of what MFA does next, so this
    // reset persists unconditionally — same immediate-plain-save shape as
    // the wrong-password path above, not deferred into a transaction that
    // might not run (the MFA-required fork below issues no session).
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await userRepo.save(user);

    const trustedDevice = trustedDeviceToken
      ? await this.mfaService.findValidTrustedDevice(
          user.id,
          trustedDeviceToken,
        )
      : null;

    if (!trustedDevice) {
      const challenge = await this.mfaService.createChallengeForLogin(user);
      return { mfaRequired: true, ...challenge };
    }

    const { session, refreshToken } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        await this.mfaService.touchTrustedDevice(manager, trustedDevice, now);
        return this.createSession(
          manager,
          user.id,
          trustedDevice.id,
          now,
          device,
        );
      },
    );

    const accessToken = await this.signAccessToken(user.id, session.id);
    return {
      mfaRequired: false,
      ...toTokenPairResponse(
        accessToken,
        refreshToken,
        ACCESS_TOKEN_TTL_SECONDS,
      ),
    };
  }

  // Verifies an MfaChallenge from an untrusted-device login and, on success,
  // completes the login: issues a session plus a brand-new TrustedDevice
  // linked to it (docs/architecture.md §3.8 — a verified challenge earns
  // trust for next time, not just this login).
  async verifyMfaChallenge(
    dto: VerifyMfaChallengeDto,
    device: DeviceMetadata,
  ): Promise<{ tokens: TokenPairResponseDto; trustedDeviceToken: string }> {
    const { userId } = await this.mfaService.verifyChallenge(
      dto.challengeId,
      dto.code,
    );

    const now = new Date();
    const { session, refreshToken, trustedDeviceToken } =
      await runInTransaction(this.dataSource, async (manager) => {
        const { device: trustedDevice, rawToken } =
          await this.mfaService.issueTrustedDevice(manager, userId, device);
        const { session, refreshToken } = await this.createSession(
          manager,
          userId,
          trustedDevice.id,
          now,
          device,
        );
        return { session, refreshToken, trustedDeviceToken: rawToken };
      });

    const accessToken = await this.signAccessToken(userId, session.id);
    return {
      tokens: toTokenPairResponse(
        accessToken,
        refreshToken,
        ACCESS_TOKEN_TTL_SECONDS,
      ),
      trustedDeviceToken,
    };
  }

  private async createSession(
    manager: EntityManager,
    userId: string,
    trustedDeviceId: string | null,
    now: Date,
    device: DeviceMetadata,
  ): Promise<{ session: Session; refreshToken: string }> {
    const refreshToken = generateOpaqueToken();
    const sessionRepo = manager.getRepository(Session);
    const session = sessionRepo.create({
      userId,
      currentTokenHash: hashOpaqueToken(refreshToken),
      previousTokenHash: null,
      status: 'active',
      trustedDeviceId,
      device,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      lastUsedAt: now,
    });
    await sessionRepo.save(session);
    return { session, refreshToken };
  }

  async refresh(dto: RefreshDto): Promise<TokenPairResponseDto> {
    const hash = hashOpaqueToken(dto.refreshToken);
    const sessionRepo = this.dataSource.getRepository(Session);

    const currentMatch = await sessionRepo.findOneBy({
      currentTokenHash: hash,
    });
    if (!currentMatch) {
      // A previous-generation token being replayed after the legitimate
      // client already rotated past it is a theft signal — see
      // docs/architecture.md §3.7.
      const previousMatch = await sessionRepo.findOne({
        where: { previousTokenHash: hash },
        relations: { user: true },
      });
      if (previousMatch) {
        previousMatch.status = 'revoked';
        await sessionRepo.save(previousMatch);

        // Published after the revoke above has committed, per
        // EventBusService's own rule — auth (core) can't call
        // NotificationService (peripheral) directly, so this goes through
        // the shared event bus; notifications' existing fire-and-forget
        // processor picks it up by job name.
        await this.eventBus.publish<string, SecurityAlertEventPayload>({
          name: SECURITY_ALERT_EVENT,
          payload: {
            userId: previousMatch.userId,
            email: previousMatch.user!.email,
            message:
              'We detected an already-used refresh token being replayed and revoked the affected session for your protection. If this wasn’t you, please change your password.',
          },
          occurredAt: new Date(),
        });

        throw new SessionRevokedException();
      }
      throw new InvalidRefreshTokenException();
    }

    const now = new Date();
    if (currentMatch.status !== 'active' || currentMatch.expiresAt <= now) {
      throw new InvalidRefreshTokenException();
    }

    const newRefreshToken = generateOpaqueToken();
    currentMatch.previousTokenHash = currentMatch.currentTokenHash;
    currentMatch.currentTokenHash = hashOpaqueToken(newRefreshToken);
    currentMatch.lastUsedAt = now;
    currentMatch.expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
    await sessionRepo.save(currentMatch);

    const accessToken = await this.signAccessToken(
      currentMatch.userId,
      currentMatch.id,
    );
    return toTokenPairResponse(
      accessToken,
      newRefreshToken,
      ACCESS_TOKEN_TTL_SECONDS,
    );
  }

  async logout(dto: LogoutDto): Promise<void> {
    const hash = hashOpaqueToken(dto.refreshToken);
    const sessionRepo = this.dataSource.getRepository(Session);

    const session = await sessionRepo.findOneBy({
      currentTokenHash: hash,
      status: 'active',
    });
    if (!session) {
      throw new InvalidRefreshTokenException();
    }

    session.status = 'revoked';
    await sessionRepo.save(session);
  }

  private signAccessToken(userId: string, sessionId: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub: userId, sid: sessionId },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );
  }
}
