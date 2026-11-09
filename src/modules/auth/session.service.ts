import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';
import { DeviceMismatchException } from '../../common/device/device-id.util';
import { runInTransaction } from '../../database/transaction.util';
import {
  SECURITY_ALERT_EVENT,
  SecurityAlertEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { UsersService } from '../users/users.service';
import { Credential } from './entities/credential.entity';
import { Session } from './entities/session.entity';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { VerifyMfaChallengeDto } from './dto/verify-mfa-challenge.dto';
import {
  TokenPairResponseDto,
  toTokenPairResponse,
} from './dto/token-pair-response.dto';
import {
  AccountLockedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  SessionRevokedException,
} from './internal/errors';
import { DeviceBindingService } from './device-binding.service';
import { TrustedDevice } from './entities/trusted-device.entity';
import { MfaService } from './mfa.service';
import { generateOpaqueToken, hashOpaqueToken } from './internal/secrets.util';
import { DeviceMetadata } from './internal/device-metadata.util';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FAILED_LOGIN_ATTEMPTS = 5; // 5 failed login attempts
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Internal to the auth module — not exported from AuthModule (see
// docs/architecture.md §10). Owns Session issuance/rotation/revocation and
// the login lockout; AuthController and MfaController are its only callers.
@Injectable()
export class SessionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly eventBus: EventBusService,
    private readonly mfaService: MfaService,
    private readonly deviceBinding: DeviceBindingService,
  ) {}

  // `trustedDeviceToken` is the raw value of the X-Trusted-Device-Token
  // header, or null if none was presented — see docs/architecture.md §3.8.
  // `device` is required, not defaulted — Session.device is NOT NULL, so
  // every caller has to supply a real value rather than the service
  // silently making one up (see ADR-0003).
  async login(
    dto: LoginDto,
    trustedDeviceToken: string | null,
    deviceId: string,
    device: DeviceMetadata,
  ): Promise<LoginResponseDto> {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new InvalidCredentialsException();
    }

    const credentialRepo = this.dataSource.getRepository(Credential);
    const credential = await credentialRepo.findOneByOrFail({
      userId: user.id,
    });

    const now = new Date();
    if (credential.lockedUntil) {
      if (credential.lockedUntil > now) {
        throw new AccountLockedException(credential.lockedUntil);
      }
      // Lockout window has passed — this attempt gets a fresh count rather
      // than instantly re-locking on one more wrong guess.
      credential.lockedUntil = null;
      credential.failedLoginAttempts = 0;
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      credential.passwordHash,
    );
    if (!passwordMatches) {
      credential.failedLoginAttempts += 1;
      if (credential.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        credential.lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
      }
      await credentialRepo.save(credential);
      throw new InvalidCredentialsException();
    }

    // The password proved correct regardless of what MFA does next, so this
    // reset persists unconditionally — same immediate-plain-save shape as
    // the wrong-password path above, not deferred into a transaction that
    // might not run (the MFA-required fork below issues no session).
    credential.failedLoginAttempts = 0;
    credential.lockedUntil = null;
    await credentialRepo.save(credential);

    const trustedDevice = trustedDeviceToken
      ? await this.mfaService.findValidTrustedDevice(
          user.id,
          trustedDeviceToken,
        )
      : null;

    if (
      !trustedDevice ||
      (this.deviceBinding.keyRequired && !trustedDevice.publicKey)
    ) {
      const challenge = await this.mfaService.createChallengeForLogin(user);
      return { mfaRequired: true, ...challenge };
    }

    await this.assertTrustedDeviceProof(trustedDevice, deviceId, dto);

    const { session, refreshToken } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        await this.mfaService.touchTrustedDevice(manager, trustedDevice, now);
        return this.createSession(
          manager,
          user.id,
          trustedDevice.id,
          deviceId,
          now,
          device,
        );
      },
    );

    const accessToken = await this.signAccessToken(
      user.id,
      session.id,
      deviceId,
    );
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
  // completes the login: registers the device key, issues a session plus a
  // brand-new TrustedDevice linked to it (docs/architecture.md §3.8 — a
  // verified challenge earns trust for next time, not just this login), and
  // retires whichever device was trusted before.
  async verifyMfaChallenge(
    dto: VerifyMfaChallengeDto,
    deviceId: string,
    device: DeviceMetadata,
  ): Promise<{ tokens: TokenPairResponseDto; trustedDeviceToken: string }> {
    const publicKey = this.deviceBinding.normalizePublicKey(
      dto.devicePublicKey,
    );
    const { userId } = await this.mfaService.verifyChallenge(
      dto.challengeId,
      dto.code,
    );
    const registered = await this.deviceBinding.attest({
      deviceId,
      publicKey,
      attestation: dto.attestation,
    });

    const now = new Date();
    const { session, refreshToken, trustedDeviceToken, replaced } =
      await runInTransaction(this.dataSource, async (manager) => {
        const {
          device: trustedDevice,
          rawToken,
          replaced,
        } = await this.mfaService.issueTrustedDevice(
          manager,
          userId,
          deviceId,
          device,
          registered,
        );
        const { session, refreshToken } = await this.createSession(
          manager,
          userId,
          trustedDevice.id,
          deviceId,
          now,
          device,
        );
        return {
          session,
          refreshToken,
          trustedDeviceToken: rawToken,
          replaced,
        };
      });

    if (replaced.some((old) => old.deviceId !== deviceId)) {
      await this.publishAlert(
        userId,
        'Your account is now signed in on a new device, so this device was signed out. If this wasn’t you, please change your password.',
      );
    }

    const accessToken = await this.signAccessToken(
      userId,
      session.id,
      deviceId,
    );
    return {
      tokens: toTokenPairResponse(
        accessToken,
        refreshToken,
        ACCESS_TOKEN_TTL_SECONDS,
      ),
      trustedDeviceToken,
    };
  }

  // A trusted-device token presented by another device, or a signature that
  // does not verify against the registered key, means the token left its
  // device: the trust and its sessions are revoked.
  private async assertTrustedDeviceProof(
    trustedDevice: TrustedDevice,
    deviceId: string,
    dto: LoginDto,
  ): Promise<void> {
    if (trustedDevice.deviceId !== deviceId) {
      await this.revokeTrustedDevice(trustedDevice, 'device_mismatch');
      throw new DeviceMismatchException();
    }
    if (!this.deviceBinding.keyRequired) {
      return;
    }
    const valid = await this.deviceBinding.verifySignedChallenge({
      purpose: 'login',
      deviceId,
      publicKey: trustedDevice.publicKey!,
      nonce: dto.nonce,
      signature: dto.signature,
    });
    if (!valid) {
      await this.revokeTrustedDevice(trustedDevice, 'bad_signature');
      throw new DeviceMismatchException();
    }
  }

  private async revokeTrustedDevice(
    trustedDevice: TrustedDevice,
    reason: 'device_mismatch' | 'bad_signature',
  ): Promise<void> {
    await runInTransaction(this.dataSource, (manager) =>
      this.mfaService.revokeTrustedDevice(manager, trustedDevice, reason),
    );
    await this.publishAlert(
      trustedDevice.userId,
      'We detected a sign-in attempt that did not come from your trusted device and signed that device out for your protection. If this wasn’t you, please change your password.',
    );
  }

  // Published after the revoke has committed, per EventBusService's own
  // rule — auth (core) can't call NotificationService (peripheral)
  // directly, so this goes through the shared event bus.
  private async publishAlert(userId: string, message: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    const occurredAt = new Date();
    await this.eventBus.publish<string, SecurityAlertEventPayload>({
      name: SECURITY_ALERT_EVENT,
      payload: {
        userId,
        email: user.email,
        message,
        occurredAt: occurredAt.toISOString(),
      },
      occurredAt,
    });
  }

  private async createSession(
    manager: EntityManager,
    userId: string,
    trustedDeviceId: string | null,
    deviceId: string,
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
      deviceId,
      device,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      lastUsedAt: now,
    });
    await sessionRepo.save(session);
    return { session, refreshToken };
  }

  async refresh(
    dto: RefreshDto,
    deviceId: string,
  ): Promise<TokenPairResponseDto> {
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
      });
      if (previousMatch) {
        await this.revokeSession(
          previousMatch,
          'We detected an already-used refresh token being replayed and revoked the affected session for your protection. If this wasn’t you, please change your password.',
        );
        throw new SessionRevokedException();
      }
      throw new InvalidRefreshTokenException();
    }

    const now = new Date();
    if (currentMatch.status !== 'active' || currentMatch.expiresAt <= now) {
      throw new InvalidRefreshTokenException();
    }

    await this.assertSessionDeviceProof(currentMatch, deviceId, dto);

    const newRefreshToken = generateOpaqueToken();
    currentMatch.previousTokenHash = currentMatch.currentTokenHash;
    currentMatch.currentTokenHash = hashOpaqueToken(newRefreshToken);
    currentMatch.lastUsedAt = now;
    currentMatch.expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
    await sessionRepo.save(currentMatch);

    const accessToken = await this.signAccessToken(
      currentMatch.userId,
      currentMatch.id,
      deviceId,
    );
    return toTokenPairResponse(
      accessToken,
      newRefreshToken,
      ACCESS_TOKEN_TTL_SECONDS,
    );
  }

  // A refresh from another device, or one whose signature does not verify
  // against the session's device key, is handled like refresh-token reuse.
  private async assertSessionDeviceProof(
    session: Session,
    deviceId: string,
    dto: RefreshDto,
  ): Promise<void> {
    const mismatchMessage =
      'A request to renew your session came from a device other than the one it was issued to, so we revoked that session for your protection. If this wasn’t you, please change your password.';
    if (session.deviceId !== deviceId) {
      await this.revokeSession(session, mismatchMessage);
      throw new DeviceMismatchException();
    }
    if (!this.deviceBinding.keyRequired) {
      return;
    }
    const trustedDevice = session.trustedDeviceId
      ? await this.dataSource
          .getRepository(TrustedDevice)
          .findOneBy({ id: session.trustedDeviceId })
      : null;
    if (!trustedDevice?.publicKey || trustedDevice.revokedAt) {
      throw new InvalidRefreshTokenException();
    }
    const valid = await this.deviceBinding.verifySignedChallenge({
      purpose: 'refresh',
      deviceId,
      publicKey: trustedDevice.publicKey,
      nonce: dto.nonce,
      signature: dto.signature,
    });
    if (!valid) {
      await this.revokeSession(session, mismatchMessage);
      throw new DeviceMismatchException();
    }
  }

  private async revokeSession(
    session: Session,
    alertMessage: string,
  ): Promise<void> {
    session.status = 'revoked';
    await this.dataSource.getRepository(Session).save(session);
    await this.publishAlert(session.userId, alertMessage);
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

  private signAccessToken(
    userId: string,
    sessionId: string,
    deviceId: string,
  ): Promise<string> {
    return this.jwtService.signAsync(
      { sub: userId, sid: sessionId, did: deviceId },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );
  }
}
