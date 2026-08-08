import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import {
  SECURITY_ALERT_EVENT,
  SecurityAlertEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { UsersService } from '../users/users.service';
import { Credential } from './entities/credential.entity';
import { SetTransactionPinDto } from './dto/set-transaction-pin.dto';
import { ChangeTransactionPinDto } from './dto/change-transaction-pin.dto';
import { ResetTransactionPinDto } from './dto/reset-transaction-pin.dto';
import { StepUpChallengeResponseDto } from './dto/step-up-challenge-response.dto';
import {
  InvalidTransactionPinException,
  MfaChallengeInvalidException,
  TransactionPinAlreadySetException,
  TransactionPinLockedException,
  TransactionPinNotSetException,
} from './internal/errors';
import { MfaService } from './mfa.service';
import { compareTransactionPin, hashTransactionPin } from './internal/pin.util';

const MAX_FAILED_PIN_ATTEMPTS = 3; // separate from login lockout — see ADR-0009
const PIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Internal to the auth module — not exported from AuthModule (see
// docs/architecture.md §10). AuthService.verifyTransactionPin delegates here
// so #22 (send-money) keeps its one documented surface; every other method
// is called directly by AuthController, same as MfaService.
@Injectable()
export class TransactionPinService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly usersService: UsersService,
    private readonly mfaService: MfaService,
    private readonly eventBus: EventBusService,
  ) {}

  // Step 1 of 2 for set-pin — same step-up shape as change-password, fires
  // unconditionally regardless of trusted-device status.
  async initiateSetPinStepUp(
    userId: string,
  ): Promise<StepUpChallengeResponseDto> {
    const user = await this.usersService.findById(userId);
    return this.mfaService.createStepUpChallenge(user);
  }

  // Step 2 of 2 — only for the first PIN on an account; an existing PIN
  // must go through changeTransactionPin or resetTransactionPin instead.
  async setTransactionPin(
    userId: string,
    dto: SetTransactionPinDto,
  ): Promise<void> {
    const { userId: challengeUserId } = await this.mfaService.verifyChallenge(
      dto.challengeId,
      dto.code,
    );
    if (challengeUserId !== userId) {
      throw new MfaChallengeInvalidException();
    }

    const credentialRepo = this.dataSource.getRepository(Credential);
    const credential = await credentialRepo.findOneByOrFail({ userId });
    if (credential.transactionPinHash) {
      throw new TransactionPinAlreadySetException();
    }

    credential.transactionPinHash = await hashTransactionPin(
      dto.pin,
      this.config.transactionPin.pepper,
    );
    await credentialRepo.save(credential);
  }

  async initiateChangePinStepUp(
    userId: string,
  ): Promise<StepUpChallengeResponseDto> {
    const user = await this.usersService.findById(userId);
    return this.mfaService.createStepUpChallenge(user);
  }

  // Verifies the step-up challenge and the current PIN, then changes the
  // PIN immediately — no pending/confirm step, same shape as
  // changePassword. The current-PIN check goes through
  // verifyAndTrackPinAttempt, so a wrong currentPin here counts toward the
  // same lockout that will gate money movement once #22 lands.
  async changeTransactionPin(
    userId: string,
    dto: ChangeTransactionPinDto,
  ): Promise<void> {
    const { userId: challengeUserId } = await this.mfaService.verifyChallenge(
      dto.challengeId,
      dto.code,
    );
    if (challengeUserId !== userId) {
      throw new MfaChallengeInvalidException();
    }

    const credential = await this.verifyAndTrackPinAttempt(
      userId,
      dto.currentPin,
    );
    credential.transactionPinHash = await hashTransactionPin(
      dto.newPin,
      this.config.transactionPin.pepper,
    );
    await this.dataSource.getRepository(Credential).save(credential);
  }

  // Recovery path for a forgotten PIN — deliberately does not call
  // verifyAndTrackPinAttempt, so it stays reachable while the PIN is locked
  // (see ADR-0009: a lock must not disable its own remedy).
  async initiateResetPinStepUp(
    userId: string,
  ): Promise<StepUpChallengeResponseDto> {
    const user = await this.usersService.findById(userId);
    return this.mfaService.createStepUpChallenge(user);
  }

  async resetTransactionPin(
    userId: string,
    dto: ResetTransactionPinDto,
  ): Promise<void> {
    const { userId: challengeUserId } = await this.mfaService.verifyChallenge(
      dto.challengeId,
      dto.code,
    );
    if (challengeUserId !== userId) {
      throw new MfaChallengeInvalidException();
    }

    const credentialRepo = this.dataSource.getRepository(Credential);
    const credential = await credentialRepo.findOneByOrFail({ userId });
    credential.transactionPinHash = await hashTransactionPin(
      dto.newPin,
      this.config.transactionPin.pepper,
    );
    credential.failedPinAttempts = 0;
    credential.pinLockedUntil = null;
    await credentialRepo.save(credential);
  }

  // The only surface #22 (send-money) needs — verifies a PIN against the
  // lockout state below and throws on failure/lock, resolves on success.
  async verifyTransactionPin(userId: string, pin: string): Promise<void> {
    await this.verifyAndTrackPinAttempt(userId, pin);
  }

  private async verifyAndTrackPinAttempt(
    userId: string,
    pin: string,
  ): Promise<Credential> {
    const credentialRepo = this.dataSource.getRepository(Credential);
    const credential = await credentialRepo.findOneByOrFail({ userId });
    if (!credential.transactionPinHash) {
      throw new TransactionPinNotSetException();
    }

    const now = new Date();
    if (credential.pinLockedUntil) {
      if (credential.pinLockedUntil > now) {
        throw new TransactionPinLockedException(credential.pinLockedUntil);
      }
      // Lockout window has passed — fresh count, same as login's lockout
      // reset above.
      credential.pinLockedUntil = null;
      credential.failedPinAttempts = 0;
    }

    const matches = await compareTransactionPin(
      pin,
      this.config.transactionPin.pepper,
      credential.transactionPinHash,
    );
    if (!matches) {
      credential.failedPinAttempts += 1;
      const justLocked =
        credential.failedPinAttempts >= MAX_FAILED_PIN_ATTEMPTS;
      if (justLocked) {
        credential.pinLockedUntil = new Date(
          now.getTime() + PIN_LOCKOUT_DURATION_MS,
        );
      }
      await credentialRepo.save(credential);

      if (justLocked) {
        const user = await this.usersService.findById(userId);
        await this.eventBus.publish<string, SecurityAlertEventPayload>({
          name: SECURITY_ALERT_EVENT,
          payload: {
            userId,
            email: user.email,
            message:
              'Your transaction PIN was locked for 15 minutes after too many failed attempts. If this wasn’t you, please secure your account and reset your PIN.',
          },
          occurredAt: new Date(),
        });
      }

      throw new InvalidTransactionPinException();
    }

    credential.failedPinAttempts = 0;
    credential.pinLockedUntil = null;
    await credentialRepo.save(credential);
    return credential;
  }
}
