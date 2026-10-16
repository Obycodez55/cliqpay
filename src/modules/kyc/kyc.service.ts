import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThan } from 'typeorm';
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
import {
  BvnAlreadyLinkedException,
  BvnVerificationFailedException,
  TooManyVerificationAttemptsException,
} from './internal/errors';
import { VerifyBvnResponseDto } from './dto/verify-bvn-response.dto';
import { KycStatusResponseDto } from './dto/kyc-status-response.dto';

const MAX_FAILED_ATTEMPTS_PER_WINDOW = 5;
const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

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

  async verifyBvn(userId: string, bvn: string): Promise<VerifyBvnResponseDto> {
    const attemptId = await this.reserveAttempt(userId, 'bvn');

    let result: KycVerificationResult;
    try {
      result = await this.kycProvider.verifyBvn(bvn);
    } catch (error) {
      await this.dataSource
        .getRepository(KycVerificationAttempt)
        .delete({ id: attemptId });
      throw error;
    }
    if (result.status !== 'verified') {
      throw new BvnVerificationFailedException();
    }

    const bvnHash = hmacHex(bvn, this.encryptionKey);
    const bvnCiphertext = encryptSecret(bvn, this.encryptionKey);

    try {
      return await runInTransaction(this.dataSource, async (manager) => {
        await this.lockUser(manager, userId);

        const repo = manager.getRepository(KycVerification);
        const existing = await repo.findOneBy({ userId });
        const record =
          existing ?? repo.create({ userId, livenessVerified: false });
        record.bvnCiphertext = bvnCiphertext;
        record.bvnHash = bvnHash;
        if (result.address) {
          record.address = { ...record.address, bvn: result.address };
        }
        record.verifiedLegalName = result.legalName ?? null;
        await repo.save(record);

        await manager
          .getRepository(KycVerificationAttempt)
          .update({ id: attemptId }, { succeeded: true });

        const currentTier = await this.usersService.getKycTier(manager, userId);
        const derivedTier = deriveTier({
          bvnVerified: true,
          ninVerified: !!record.ninHash,
          livenessVerified: record.livenessVerified,
        });
        const tierIncreased = tierRank(derivedTier) > tierRank(currentTier);
        if (tierIncreased) {
          await this.usersService.setKycTier(manager, userId, derivedTier);
        }

        return {
          tier: tierIncreased ? derivedTier : currentTier,
          bvnVerified: true,
          ninVerified: !!record.ninHash,
          livenessVerified: record.livenessVerified,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_kyc_verifications_bvn_hash_partial')) {
        throw new BvnAlreadyLinkedException();
      }
      throw error;
    }
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

  // Counted as failed under the user's lock before the provider call so
  // concurrent requests can't all pass the limit; a success flips it. The
  // provider call stays outside every transaction.
  private reserveAttempt(
    userId: string,
    identityType: KycIdentityType,
  ): Promise<string> {
    return runInTransaction(this.dataSource, async (manager) => {
      await this.lockUser(manager, userId);

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
      return attempt.id;
    });
  }

  private async lockUser(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
  }
}
