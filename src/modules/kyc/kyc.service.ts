import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThan } from 'typeorm';
import { Money } from '../../shared/primitives/money';
import { APP_CONFIG, AppConfig } from '../../config';
import {
  encryptSecret,
  encryptionKeyFromHex,
  hmacHex,
} from '../../shared/crypto/secrets.util';
import { isUniqueViolation } from '../../database/postgres-errors.util';
import { runInTransaction } from '../../database/transaction.util';
import { UsersService } from '../users/users.service';
import { KycVerification } from './entities/kyc-verification.entity';
import { TierLimit } from './entities/tier-limit.entity';
import {
  KycIdentityType,
  KycVerificationAttempt,
} from './entities/kyc-verification-attempt.entity';
import {
  KYC_PROVIDER,
  KycProvider,
  KycVerificationResult,
} from './providers/kyc-provider.interface';
import { deriveTier, tierRank } from './internal/tier';
import { startOfDay } from './internal/day-start';
import {
  BvnAlreadyLinkedException,
  BvnAlreadyVerifiedException,
  BvnVerificationFailedException,
  DailyLimitExceededException,
  NinAlreadyLinkedException,
  NinAlreadyVerifiedException,
  NinVerificationFailedException,
  TierLimitNotConfiguredException,
  TooManyVerificationAttemptsException,
} from './internal/errors';
import { VerifyIdentityResponseDto } from './dto/verify-identity-response.dto';
import { KycStatusResponseDto } from './dto/kyc-status-response.dto';

// Becomes the user's own timezone once profiles carry one.
const DEFAULT_USER_TIME_ZONE = 'Africa/Lagos';

const MAX_FAILED_ATTEMPTS_PER_WINDOW = 5;
const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

const IDENTITY_SPECS = {
  bvn: {
    failed: BvnVerificationFailedException,
    alreadyLinked: BvnAlreadyLinkedException,
    alreadyVerified: BvnAlreadyVerifiedException,
    uniqueConstraint: 'UQ_kyc_verifications_bvn_hash_partial',
  },
  nin: {
    failed: NinVerificationFailedException,
    alreadyLinked: NinAlreadyLinkedException,
    alreadyVerified: NinAlreadyVerifiedException,
    uniqueConstraint: 'UQ_kyc_verifications_nin_hash_partial',
  },
} as const;

@Injectable()
export class KycService {
  private readonly encryptionKey: Buffer;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(KYC_PROVIDER) private readonly kycProvider: KycProvider,
    private readonly usersService: UsersService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.encryptionKey = encryptionKeyFromHex(config.encryption.key);
  }

  verifyBvn(userId: string, bvn: string): Promise<VerifyIdentityResponseDto> {
    return this.verifyIdentity(userId, 'bvn', bvn);
  }

  verifyNin(userId: string, nin: string): Promise<VerifyIdentityResponseDto> {
    return this.verifyIdentity(userId, 'nin', nin);
  }

  private async verifyIdentity(
    userId: string,
    identityType: KycIdentityType,
    idNumber: string,
  ): Promise<VerifyIdentityResponseDto> {
    const spec = IDENTITY_SPECS[identityType];
    const hash = hmacHex(idNumber, this.encryptionKey);
    const reservation = await this.reserveAttempt(userId, identityType, hash);
    if ('currentState' in reservation) {
      return reservation.currentState;
    }
    const { attemptId } = reservation;

    let result: KycVerificationResult;
    try {
      result =
        identityType === 'bvn'
          ? await this.kycProvider.verifyBvn(idNumber)
          : await this.kycProvider.verifyNin(idNumber);
    } catch (error) {
      await this.dataSource
        .getRepository(KycVerificationAttempt)
        .delete({ id: attemptId });
      throw error;
    }
    if (result.status !== 'verified') {
      throw new spec.failed();
    }

    const ciphertext = encryptSecret(idNumber, this.encryptionKey);

    try {
      return await runInTransaction(this.dataSource, async (manager) => {
        await this.lockUser(manager, userId);

        const repo = manager.getRepository(KycVerification);
        const existing = await repo.findOneBy({ userId });
        // A concurrent request may have verified a different identifier while
        // this one was at the provider.
        const storedHash =
          identityType === 'bvn' ? existing?.bvnHash : existing?.ninHash;
        if (storedHash && storedHash !== hash) {
          throw new spec.alreadyVerified();
        }
        const record =
          existing ?? repo.create({ userId, livenessVerified: false });
        if (identityType === 'bvn') {
          record.bvnCiphertext = ciphertext;
          record.bvnHash = hash;
        } else {
          record.ninCiphertext = ciphertext;
          record.ninHash = hash;
        }
        if (result.address) {
          record.address = {
            ...record.address,
            [identityType]: result.address,
          };
        }
        // The BVN name wins; a NIN name only fills in until a BVN is verified.
        if (result.legalName && (identityType === 'bvn' || !record.bvnHash)) {
          record.verifiedLegalName = result.legalName;
        }
        await repo.save(record);

        await manager
          .getRepository(KycVerificationAttempt)
          .update({ id: attemptId }, { succeeded: true });

        const bvnVerified = !!record.bvnHash;
        const ninVerified = !!record.ninHash;
        const currentTier = await this.usersService.getKycTier(manager, userId);
        const derivedTier = deriveTier({
          bvnVerified,
          ninVerified,
          livenessVerified: record.livenessVerified,
        });
        const tierIncreased = tierRank(derivedTier) > tierRank(currentTier);
        if (tierIncreased) {
          await this.usersService.setKycTier(manager, userId, derivedTier);
        }

        return {
          tier: tierIncreased ? derivedTier : currentTier,
          bvnVerified,
          ninVerified,
          livenessVerified: record.livenessVerified,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, spec.uniqueConstraint)) {
        throw new spec.alreadyLinked();
      }
      throw error;
    }
  }

  async checkAndReserveLimit(
    manager: EntityManager,
    userId: string,
    amount: Money,
    readDebitedSince: (manager: EntityManager, since: Date) => Promise<Money>,
  ): Promise<void> {
    await this.lockUser(manager, userId);

    const tier = await this.usersService.getKycTier(manager, userId);
    const tierLimit = await manager
      .getRepository(TierLimit)
      .findOneBy({ tier, currency: amount.currency });
    if (!tierLimit) {
      throw new TierLimitNotConfiguredException();
    }

    const dailyLimit = Money.of(
      tierLimit.dailyDebitLimitMinor,
      amount.currency,
    );
    const debited = await readDebitedSince(
      manager,
      startOfDay(new Date(), this.timeZoneFor(userId)),
    );
    if (debited.add(amount).greaterThan(dailyLimit)) {
      const remaining = dailyLimit.greaterThan(debited)
        ? dailyLimit.subtract(debited)
        : Money.zero(amount.currency);
      throw new DailyLimitExceededException(dailyLimit, remaining);
    }
  }

  private timeZoneFor(_userId: string): string {
    return DEFAULT_USER_TIME_ZONE;
  }

  async getStatus(userId: string): Promise<KycStatusResponseDto> {
    const [record, user] = await Promise.all([
      this.dataSource.getRepository(KycVerification).findOneBy({ userId }),
      this.usersService.findById(userId),
    ]);

    return {
      tier: user.kycTier,
      bvnVerified: !!record?.bvnHash,
      ninVerified: !!record?.ninHash,
      livenessVerified: record?.livenessVerified ?? false,
      dailyAllowanceRemainingMinor: 0,
    };
  }

  // A verified identity is immutable through the API: resubmitting it is a free
  // no-op, a different one is rejected, so a freed hash can't be claimed by
  // another account.
  private async resolveVerifiedIdentity(
    manager: EntityManager,
    userId: string,
    identityType: KycIdentityType,
    hash: string,
  ): Promise<VerifyIdentityResponseDto | null> {
    const record = await manager
      .getRepository(KycVerification)
      .findOneBy({ userId });
    const storedHash =
      identityType === 'bvn' ? record?.bvnHash : record?.ninHash;
    if (!record || !storedHash) {
      return null;
    }
    if (storedHash !== hash) {
      throw new IDENTITY_SPECS[identityType].alreadyVerified();
    }
    return {
      tier: await this.usersService.getKycTier(manager, userId),
      bvnVerified: !!record.bvnHash,
      ninVerified: !!record.ninHash,
      livenessVerified: record.livenessVerified,
    };
  }

  // Counted as failed under the user's lock before the provider call so
  // concurrent requests can't all pass the limit; a success flips it. The
  // provider call stays outside every transaction.
  private reserveAttempt(
    userId: string,
    identityType: KycIdentityType,
    hash: string,
  ): Promise<
    { attemptId: string } | { currentState: VerifyIdentityResponseDto }
  > {
    return runInTransaction(this.dataSource, async (manager) => {
      await this.lockUser(manager, userId);

      const currentState = await this.resolveVerifiedIdentity(
        manager,
        userId,
        identityType,
        hash,
      );
      if (currentState) {
        return { currentState };
      }

      const repo = manager.getRepository(KycVerificationAttempt);
      const failedCount = await repo.count({
        where: {
          userId,
          identityType,
          succeeded: false,
          createdAt: MoreThan(new Date(Date.now() - ATTEMPT_WINDOW_MS)),
        },
      });
      if (failedCount >= MAX_FAILED_ATTEMPTS_PER_WINDOW) {
        throw new TooManyVerificationAttemptsException();
      }

      const attempt = await repo.save(
        repo.create({ userId, identityType, succeeded: false }),
      );
      return { attemptId: attempt.id };
    });
  }

  private async lockUser(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
  }
}
