import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomInt } from 'crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { DataSource, EntityManager } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import {
  MFA_CHALLENGE_OTP_EVENT,
  MfaChallengeOtpEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { MfaChallenge } from './entities/mfa-challenge.entity';
import { MfaMethod } from './entities/mfa-method.entity';
import { TrustedDevice } from './entities/trusted-device.entity';
import { User } from './entities/user.entity';
import {
  InvalidMfaCodeException,
  MfaChallengeInvalidException,
  MfaChallengeNotFoundException,
  NoPendingTotpEnrollmentException,
  TotpAlreadyEnrolledException,
} from './internal/errors';
import {
  decryptSecret,
  encryptSecret,
  encryptionKeyFromHex,
  generateOpaqueToken,
  hashOpaqueToken,
} from './internal/secrets.util';
import { DeviceMetadata } from './internal/device-metadata.util';

const TOTP_ISSUER = 'Cliqpay';
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days
// Constant-time-ish TOTP window — ±1 step (±30s) tolerates ordinary clock
// drift between the server and the user's authenticator app.
const TOTP_EPOCH_TOLERANCE = 1;

function generateNumericCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Internal to the auth module — not exported from AuthModule (see
 * docs/architecture.md §10). Owns MfaMethod/MfaChallenge/TrustedDevice;
 * AuthService and MfaController are its only callers.
 */
@Injectable()
export class MfaService {
  private readonly encryptionKey: Buffer;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly eventBus: EventBusService,
  ) {
    this.encryptionKey = encryptionKeyFromHex(config.encryption.key);
  }

  // Runs inside the caller's transaction (register()'s user+wallet insert)
  // — every account gets this atomically, with no separate enrollment call,
  // per issue #4. Permanent and non-removable: no endpoint in this module
  // ever deletes or deactivates an email MfaMethod.
  async enrollEmailMethod(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const repo = manager.getRepository(MfaMethod);
    const method = repo.create({
      userId,
      type: 'email',
      status: 'active',
      secretCiphertext: null,
    });
    await repo.save(method);
  }

  async createChallengeForLogin(user: User): Promise<{
    challengeId: string;
    method: 'email' | 'totp';
    expiresAt: Date;
  }> {
    const methods = await this.dataSource
      .getRepository(MfaMethod)
      .find({ where: { userId: user.id } });
    const method = this.pickChallengeMethod(methods);
    const challenge = await this.createChallenge(user, method);
    return {
      challengeId: challenge.id,
      method: method.type,
      expiresAt: challenge.expiresAt,
    };
  }

  // Security keys aside (not built this issue), TOTP > email — see
  // docs/architecture.md §3.8 — so an active TOTP method is challenged in
  // preference to email whenever both are enrolled.
  private pickChallengeMethod(methods: MfaMethod[]): MfaMethod {
    const totp = methods.find(
      (m) => m.type === 'totp' && m.status === 'active',
    );
    if (totp) {
      return totp;
    }
    const email = methods.find(
      (m) => m.type === 'email' && m.status === 'active',
    );
    if (!email) {
      // Every account gets an active email method at registration and it's
      // never removable — reaching this means that invariant broke.
      throw new Error(
        `User ${methods[0]?.userId ?? '?'} has no active MFA method`,
      );
    }
    return email;
  }

  private async createChallenge(
    user: User,
    method: MfaMethod,
  ): Promise<MfaChallenge> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
    const challengeRepo = this.dataSource.getRepository(MfaChallenge);

    let codeHash: string | null = null;
    let plainCode: string | null = null;
    if (method.type === 'email') {
      plainCode = generateNumericCode();
      codeHash = hashCode(plainCode);
    }

    const challenge = challengeRepo.create({
      methodId: method.id,
      codeHash,
      status: 'pending',
      attempts: 0,
      expiresAt,
    });
    await challengeRepo.save(challenge);

    if (method.type === 'email' && plainCode) {
      await this.eventBus.dispatchAndAwait<string, MfaChallengeOtpEventPayload>(
        {
          name: MFA_CHALLENGE_OTP_EVENT,
          payload: {
            userId: user.id,
            email: user.email,
            code: plainCode,
            expiresInMinutes: CHALLENGE_TTL_MS / 60_000,
          },
          occurredAt: now,
        },
      );
    }

    return challenge;
  }

  // Plain repo writes, not wrapped in the caller's transaction — a wrong
  // attempt must persist (the attempt counter) even though the caller then
  // throws, so it can't roll back with whatever transaction wraps the
  // eventual success path. Mirrors AuthService.login()'s own
  // password-attempt bookkeeping, which is the same shape for the same
  // reason.
  async verifyChallenge(
    challengeId: string,
    code: string,
  ): Promise<{ userId: string }> {
    const challengeRepo = this.dataSource.getRepository(MfaChallenge);
    const challenge = await challengeRepo.findOneBy({ id: challengeId });
    if (!challenge) {
      throw new MfaChallengeNotFoundException();
    }

    const now = new Date();
    if (challenge.status !== 'pending' || challenge.expiresAt <= now) {
      throw new MfaChallengeInvalidException();
    }

    const method = await this.dataSource
      .getRepository(MfaMethod)
      .findOneByOrFail({ id: challenge.methodId });

    const isCorrect = await this.checkCode(method, challenge, code);
    if (!isCorrect) {
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
        challenge.status = 'failed';
      }
      await challengeRepo.save(challenge);
      throw new InvalidMfaCodeException();
    }

    challenge.status = 'verified';
    await challengeRepo.save(challenge);
    return { userId: method.userId };
  }

  private async checkCode(
    method: MfaMethod,
    challenge: MfaChallenge,
    code: string,
  ): Promise<boolean> {
    if (method.type === 'email') {
      return challenge.codeHash === hashCode(code);
    }
    const secret = decryptSecret(method.secretCiphertext!, this.encryptionKey);
    const result = await verify({
      secret,
      token: code,
      epochTolerance: TOTP_EPOCH_TOLERANCE,
    });
    return result.valid;
  }

  async findValidTrustedDevice(
    userId: string,
    rawToken: string,
  ): Promise<TrustedDevice | null> {
    const device = await this.dataSource
      .getRepository(TrustedDevice)
      .findOneBy({ tokenHash: hashOpaqueToken(rawToken) });
    if (!device || device.userId !== userId || device.expiresAt <= new Date()) {
      return null;
    }
    return device;
  }

  async touchTrustedDevice(
    manager: EntityManager,
    device: TrustedDevice,
    now: Date,
  ): Promise<void> {
    device.lastUsedAt = now;
    await manager.getRepository(TrustedDevice).save(device);
  }

  async issueTrustedDevice(
    manager: EntityManager,
    userId: string,
    device: DeviceMetadata,
  ): Promise<{ device: TrustedDevice; rawToken: string }> {
    const now = new Date();
    const rawToken = generateOpaqueToken();
    const repo = manager.getRepository(TrustedDevice);
    const trustedDevice = repo.create({
      userId,
      tokenHash: hashOpaqueToken(rawToken),
      device,
      expiresAt: new Date(now.getTime() + TRUSTED_DEVICE_TTL_MS),
      lastUsedAt: now,
    });
    await repo.save(trustedDevice);
    return { device: trustedDevice, rawToken };
  }

  async enrollTotp(
    userId: string,
  ): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.dataSource
      .getRepository(User)
      .findOneByOrFail({ id: userId });
    const methodRepo = this.dataSource.getRepository(MfaMethod);
    const existing = await methodRepo.findOneBy({ userId, type: 'totp' });
    if (existing?.status === 'active') {
      throw new TotpAlreadyEnrolledException();
    }

    const secret = generateSecret();
    const otpauthUrl = generateURI({
      issuer: TOTP_ISSUER,
      label: user.email,
      secret,
    });
    const secretCiphertext = encryptSecret(secret, this.encryptionKey);

    if (existing) {
      existing.secretCiphertext = secretCiphertext;
      existing.status = 'pending';
      await methodRepo.save(existing);
    } else {
      const method = methodRepo.create({
        userId,
        type: 'totp',
        status: 'pending',
        secretCiphertext,
      });
      await methodRepo.save(method);
    }

    return { secret, otpauthUrl };
  }

  async confirmTotp(userId: string, code: string): Promise<void> {
    const methodRepo = this.dataSource.getRepository(MfaMethod);
    const method = await methodRepo.findOneBy({
      userId,
      type: 'totp',
      status: 'pending',
    });
    if (!method) {
      throw new NoPendingTotpEnrollmentException();
    }

    const secret = decryptSecret(method.secretCiphertext!, this.encryptionKey);
    const result = await verify({
      secret,
      token: code,
      epochTolerance: TOTP_EPOCH_TOLERANCE,
    });
    if (!result.valid) {
      throw new InvalidMfaCodeException();
    }

    method.status = 'active';
    await methodRepo.save(method);
  }
}
