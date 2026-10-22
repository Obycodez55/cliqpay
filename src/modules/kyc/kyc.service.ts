import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  LessThan,
  MoreThan,
  Not,
} from 'typeorm';
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
import { KycLivenessJob } from './entities/kyc-liveness-job.entity';
import {
  KycIdentityType,
  KycVerificationAttempt,
} from './entities/kyc-verification-attempt.entity';
import {
  KYC_PROVIDER,
  KycProvider,
  KycVerificationResult,
  LivenessOutcome,
  LivenessSubmissionResult,
} from './providers/kyc-provider.interface';
import { KycTier } from '../users/users.service';
import { deriveTier, tierRank } from './internal/tier';
import { startOfDay } from './internal/day-start';
import {
  BalanceCapExceededException,
  BvnAlreadyLinkedException,
  BvnAlreadyVerifiedException,
  BvnVerificationFailedException,
  DailyLimitExceededException,
  LivenessInProgressException,
  NinAlreadyLinkedException,
  NinAlreadyVerifiedException,
  NinVerificationFailedException,
  TierLimitNotConfiguredException,
  TooManyVerificationAttemptsException,
} from './internal/errors';
import {
  LivenessResult,
  VerifyIdentityResponseDto,
} from './dto/verify-identity-response.dto';
import { LivenessCaptureDto } from './dto/liveness-capture.dto';
import { KycStatusResponseDto } from './dto/kyc-status-response.dto';

// Becomes the user's own timezone once profiles carry one.
const DEFAULT_USER_TIME_ZONE = 'Africa/Lagos';

const MAX_FAILED_ATTEMPTS_PER_WINDOW = 5;
const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIVENESS_JOB_TTL_MS = 30 * 60 * 1000;
const LIVENESS_POLL_BATCH = 100;

const LIVENESS_PENDING_CONSTRAINT = 'UQ_kyc_liveness_jobs_user_pending';

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
  private readonly logger = new Logger(KycService.name);
  private readonly encryptionKey: Buffer;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(KYC_PROVIDER) private readonly kycProvider: KycProvider,
    private readonly usersService: UsersService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.encryptionKey = encryptionKeyFromHex(config.encryption.key);
  }

  verifyBvn(
    userId: string,
    bvn: string,
    liveness?: LivenessCaptureDto,
  ): Promise<VerifyIdentityResponseDto> {
    return this.verifyIdentity(userId, 'bvn', bvn, liveness);
  }

  verifyNin(
    userId: string,
    nin: string,
    liveness?: LivenessCaptureDto,
  ): Promise<VerifyIdentityResponseDto> {
    return this.verifyIdentity(userId, 'nin', nin, liveness);
  }

  private async verifyIdentity(
    userId: string,
    identityType: KycIdentityType,
    idNumber: string,
    liveness?: LivenessCaptureDto,
  ): Promise<VerifyIdentityResponseDto> {
    const hash = hmacHex(idNumber, this.encryptionKey);
    const reservation = await this.reserveAttempt(
      userId,
      identityType,
      hash,
      !!liveness,
    );
    if ('currentState' in reservation) {
      return reservation.currentState;
    }
    const { attemptId, identityVerified, submitLiveness } = reservation;

    if (!identityVerified) {
      await this.verifyAndPersistIdentity(
        userId,
        identityType,
        idNumber,
        hash,
        attemptId,
        submitLiveness,
      );
    }

    if (!liveness) {
      return this.readState(userId, 'not_requested');
    }
    if (!submitLiveness) {
      return this.readState(userId, 'passed');
    }
    const livenessResult = await this.runLiveness(
      userId,
      identityType,
      idNumber,
      attemptId,
      liveness,
    );
    return this.readState(userId, livenessResult);
  }

  private async verifyAndPersistIdentity(
    userId: string,
    identityType: KycIdentityType,
    idNumber: string,
    hash: string,
    attemptId: string,
    awaitingLiveness: boolean,
  ): Promise<void> {
    const spec = IDENTITY_SPECS[identityType];
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
      await runInTransaction(this.dataSource, async (manager) => {
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

        // With a selfie the attempt only succeeds once liveness passes too.
        if (!awaitingLiveness) {
          await manager
            .getRepository(KycVerificationAttempt)
            .update({ id: attemptId }, { succeeded: true });
        }

        await this.raiseTier(manager, userId, record);
      });
    } catch (error) {
      if (isUniqueViolation(error, spec.uniqueConstraint)) {
        throw new spec.alreadyLinked();
      }
      throw error;
    }
  }

  private async runLiveness(
    userId: string,
    identityType: KycIdentityType,
    idNumber: string,
    attemptId: string,
    liveness: LivenessCaptureDto,
  ): Promise<LivenessResult> {
    const jobRepo = this.dataSource.getRepository(KycLivenessJob);
    let job: KycLivenessJob;
    try {
      job = await jobRepo.save(
        jobRepo.create({
          userId,
          attemptId,
          identityType,
          providerJobId: null,
          status: 'pending',
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, LIVENESS_PENDING_CONSTRAINT)) {
        throw new LivenessInProgressException();
      }
      throw error;
    }

    const user = await this.usersService.findById(userId);
    let submission: LivenessSubmissionResult;
    try {
      submission = await this.kycProvider.submitLiveness({
        idType: identityType,
        idNumber,
        selfieImage: liveness.selfieImage,
        livenessImages: liveness.livenessImages,
        user: {
          givenNames: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
        },
        consentGrantedAt: new Date(),
      });
    } catch (error) {
      await this.dataSource
        .getRepository(KycVerificationAttempt)
        .delete({ id: attemptId });
      throw error;
    }

    if (submission.status === 'pending') {
      await jobRepo.update({ id: job.id }, { providerJobId: submission.jobId });
      return 'pending';
    }
    await this.applyLivenessOutcome(job.id, submission.status);
    return submission.status;
  }

  private async applyLivenessOutcome(
    jobId: string,
    outcome: LivenessOutcome,
  ): Promise<void> {
    const peeked = await this.dataSource
      .getRepository(KycLivenessJob)
      .findOneBy({ id: jobId });
    if (!peeked) {
      return;
    }
    const { userId } = peeked;

    await runInTransaction(this.dataSource, async (manager) => {
      await this.lockUser(manager, userId);

      const jobRepo = manager.getRepository(KycLivenessJob);
      const job = await jobRepo.findOneBy({ id: jobId });
      if (!job || job.status !== 'pending') {
        return;
      }
      await jobRepo.update({ id: jobId }, { status: outcome });
      if (outcome !== 'passed') {
        return;
      }

      const repo = manager.getRepository(KycVerification);
      const record = await repo.findOneByOrFail({ userId });
      record.livenessVerified = true;
      await repo.save(record);
      await manager
        .getRepository(KycVerificationAttempt)
        .update({ id: job.attemptId }, { succeeded: true });
      await this.raiseTier(manager, userId, record);
    });
  }

  async pollPendingLivenessJobs(): Promise<void> {
    const repo = this.dataSource.getRepository(KycLivenessJob);
    await repo.update(
      {
        status: 'pending',
        createdAt: LessThan(new Date(Date.now() - LIVENESS_JOB_TTL_MS)),
      },
      { status: 'failed' },
    );
    const jobs = await repo.find({
      where: { status: 'pending', providerJobId: Not(IsNull()) },
      order: { createdAt: 'ASC' },
      take: LIVENESS_POLL_BATCH,
    });
    for (const job of jobs) {
      await this.pollLivenessJob(job);
    }
  }

  async handleLivenessWebhook(body: unknown): Promise<void> {
    const providerJobId = this.kycProvider.parseWebhookJobId(body);
    if (!providerJobId) {
      return;
    }
    const job = await this.dataSource
      .getRepository(KycLivenessJob)
      .findOneBy({ providerJobId, status: 'pending' });
    if (job) {
      await this.pollLivenessJob(job);
    }
  }

  private async pollLivenessJob(job: KycLivenessJob): Promise<void> {
    try {
      const outcome = await this.kycProvider.getLivenessResult(
        job.providerJobId!,
      );
      if (outcome !== 'pending') {
        await this.applyLivenessOutcome(job.id, outcome);
      }
    } catch (error) {
      this.logger.warn(
        `Liveness poll failed for job ${job.id}: ${(error as Error).message}`,
      );
    }
  }

  private async raiseTier(
    manager: EntityManager,
    userId: string,
    record: KycVerification,
  ): Promise<void> {
    const currentTier = await this.usersService.getKycTier(manager, userId);
    const derivedTier = deriveTier({
      bvnVerified: !!record.bvnHash,
      ninVerified: !!record.ninHash,
      livenessVerified: record.livenessVerified,
    });
    if (tierRank(derivedTier) > tierRank(currentTier)) {
      await this.usersService.setKycTier(manager, userId, derivedTier);
    }
  }

  private readState(
    userId: string,
    livenessResult: LivenessResult,
  ): Promise<VerifyIdentityResponseDto> {
    return runInTransaction(this.dataSource, (manager) =>
      this.stateOf(manager, userId, livenessResult),
    );
  }

  private async stateOf(
    manager: EntityManager,
    userId: string,
    livenessResult: LivenessResult,
  ): Promise<VerifyIdentityResponseDto> {
    const record = await manager
      .getRepository(KycVerification)
      .findOneBy({ userId });
    const tier: KycTier = await this.usersService.getKycTier(manager, userId);
    return {
      tier,
      bvnVerified: !!record?.bvnHash,
      ninVerified: !!record?.ninHash,
      livenessVerified: record?.livenessVerified ?? false,
      livenessResult,
    };
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

  async checkBalanceCap(
    manager: EntityManager,
    userId: string,
    requested: Money,
    readBalanceAndPending: (
      manager: EntityManager,
    ) => Promise<{ balance: Money; pending: Money }>,
  ): Promise<void> {
    await this.lockUser(manager, userId);

    const tier = await this.usersService.getKycTier(manager, userId);
    const tierLimit = await manager
      .getRepository(TierLimit)
      .findOneBy({ tier, currency: requested.currency });
    if (!tierLimit) {
      throw new TierLimitNotConfiguredException();
    }
    if (tierLimit.balanceCapMinor === null) {
      return;
    }

    const cap = Money.of(tierLimit.balanceCapMinor, requested.currency);
    const { balance, pending } = await readBalanceAndPending(manager);
    const projected = balance.add(pending);
    if (projected.add(requested).greaterThan(cap)) {
      const remaining = cap.greaterThan(projected)
        ? cap.subtract(projected)
        : Money.zero(requested.currency);
      throw new BalanceCapExceededException(cap, remaining);
    }
  }

  private timeZoneFor(_userId: string): string {
    return DEFAULT_USER_TIME_ZONE;
  }

  async getStatus(userId: string): Promise<KycStatusResponseDto> {
    const [record, user, pendingJobs] = await Promise.all([
      this.dataSource.getRepository(KycVerification).findOneBy({ userId }),
      this.usersService.findById(userId),
      this.dataSource
        .getRepository(KycLivenessJob)
        .countBy({ userId, status: 'pending' }),
    ]);

    return {
      tier: user.kycTier,
      bvnVerified: !!record?.bvnHash,
      ninVerified: !!record?.ninHash,
      livenessVerified: record?.livenessVerified ?? false,
      livenessPending: pendingJobs > 0,
      dailyAllowanceRemainingMinor: 0,
    };
  }

  // A verified identity is immutable through the API: resubmitting it is a free
  // no-op and a different one is rejected, so a freed hash can't be claimed by
  // another account. The one exception is a liveness capture sent while
  // liveness is still unverified. Anything that proceeds is counted as a
  // failed attempt under the user's lock before the provider call, so
  // concurrent requests can't all pass the limit; success flips it. Provider
  // calls stay outside every transaction.
  private reserveAttempt(
    userId: string,
    identityType: KycIdentityType,
    hash: string,
    livenessRequested: boolean,
  ): Promise<
    | { currentState: VerifyIdentityResponseDto }
    | {
        attemptId: string;
        identityVerified: boolean;
        submitLiveness: boolean;
      }
  > {
    return runInTransaction(this.dataSource, async (manager) => {
      await this.lockUser(manager, userId);

      const record = await manager
        .getRepository(KycVerification)
        .findOneBy({ userId });
      const storedHash =
        identityType === 'bvn' ? record?.bvnHash : record?.ninHash;
      if (storedHash && storedHash !== hash) {
        throw new IDENTITY_SPECS[identityType].alreadyVerified();
      }
      const identityVerified = !!storedHash;
      const livenessAlreadyVerified = record?.livenessVerified ?? false;
      const submitLiveness = livenessRequested && !livenessAlreadyVerified;

      if (identityVerified && !submitLiveness) {
        return {
          currentState: await this.stateOf(
            manager,
            userId,
            livenessRequested ? 'passed' : 'not_requested',
          ),
        };
      }

      if (submitLiveness) {
        const pending = await manager
          .getRepository(KycLivenessJob)
          .countBy({ userId, status: 'pending' });
        if (pending > 0) {
          throw new LivenessInProgressException();
        }
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
      return { attemptId: attempt.id, identityVerified, submitLiveness };
    });
  }

  private async lockUser(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
  }
}
