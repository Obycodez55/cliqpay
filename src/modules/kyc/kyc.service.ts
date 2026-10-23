import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  LessThan,
  MoreThan,
  MoreThanOrEqual,
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
import { identitiesMatch } from './internal/identity-match';
import { startOfDay } from './internal/day-start';
import {
  BalanceCapExceededException,
  BvnAlreadyLinkedException,
  BvnAlreadyVerifiedException,
  BvnVerificationFailedException,
  DailyLimitExceededException,
  IdentityMismatchException,
  KycLivenessUnavailableException,
  KycVerificationRequiredException,
  LivenessInProgressException,
  RecipientCannotReceiveException,
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

export type IncomingCreditVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'zero_cap' | 'over_cap';
      cap: Money;
      remaining: Money;
    };

type BalanceAndPendingReader = (
  manager: EntityManager,
) => Promise<{ balance: Money; pending: Money }>;

// The only currency with tier limits so far.
const STATUS_CURRENCY = 'NGN';

export interface WalletCapacity {
  tier: KycTier;
  dailyLimit: Money;
  debitedToday: Money;
  remainingToday: Money;
  resetsAt: Date;
  balanceCap: Money | null;
  balance: Money;
  pendingFunding: Money;
  headroom: Money | null;
}

function remainingBelow(limit: Money, used: Money): Money {
  return limit.greaterThan(used)
    ? limit.subtract(used)
    : Money.zero(limit.currency);
}

const MAX_FAILED_ATTEMPTS_PER_WINDOW = 5;
const ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIVENESS_JOB_TTL_MS = 30 * 60 * 1000;
const LIVENESS_POLL_BATCH = 100;
const LIVENESS_POLL_TICK_BUDGET_MS = 60 * 1000;
const LIVENESS_MAX_POLL_FAILURES = 5;
const PRUNE_BATCH_SIZE = 1000;

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
  private readonly identifierHashKey: Buffer;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(KYC_PROVIDER) private readonly kycProvider: KycProvider,
    private readonly usersService: UsersService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.encryptionKey = encryptionKeyFromHex(config.encryption.key);
    this.identifierHashKey = encryptionKeyFromHex(config.identifierHash.key);
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
    if (liveness && !this.kycProvider.supportsLiveness) {
      throw new KycLivenessUnavailableException();
    }
    const hash = hmacHex(idNumber, this.identifierHashKey);
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
        // Whichever identifier is verified second is checked against the first,
        // before anything is written.
        const otherType = identityType === 'bvn' ? 'nin' : 'bvn';
        const otherHash =
          otherType === 'bvn' ? existing?.bvnHash : existing?.ninHash;
        if (
          otherHash &&
          !identitiesMatch(existing?.identity?.[otherType] ?? {}, {
            legalName: result.legalName,
            dateOfBirth: result.dateOfBirth,
          })
        ) {
          throw new IdentityMismatchException(identityType);
        }
        const record =
          existing ?? repo.create({ userId, livenessVerified: false });
        record.identity = {
          ...record.identity,
          [identityType]: {
            legalName: result.legalName,
            dateOfBirth: result.dateOfBirth,
          },
        };
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

  // Oldest first and bounded by a time budget, so a provider outage can't make
  // one tick outrun the next; the following tick carries on where this one
  // stopped.
  async pollPendingLivenessJobs(): Promise<void> {
    const repo = this.dataSource.getRepository(KycLivenessJob);
    const deadline = Date.now() + LIVENESS_POLL_TICK_BUDGET_MS;
    const cutoff = new Date(Date.now() - LIVENESS_JOB_TTL_MS);

    const expired = await repo.find({
      where: { status: 'pending', createdAt: LessThan(cutoff) },
      order: { createdAt: 'ASC' },
      take: LIVENESS_POLL_BATCH,
    });
    for (const job of expired) {
      if (Date.now() >= deadline) {
        return;
      }
      await this.expireLivenessJob(job);
    }

    const jobs = await repo.find({
      where: {
        status: 'pending',
        providerJobId: Not(IsNull()),
        createdAt: MoreThanOrEqual(cutoff),
        pollFailures: LessThan(LIVENESS_MAX_POLL_FAILURES),
      },
      order: { createdAt: 'ASC' },
      take: LIVENESS_POLL_BATCH,
    });
    for (const job of jobs) {
      if (Date.now() >= deadline) {
        return;
      }
      await this.pollLivenessJob(job);
    }
  }

  // Attempts hold a cascading foreign key to liveness jobs, so an attempt that
  // still has a pending job is kept: deleting it would silently delete the job.
  async pruneBookkeeping(
    olderThan: Date,
  ): Promise<{ livenessJobs: number; attempts: number }> {
    const livenessJobs = await this.deleteInBatches(
      `DELETE FROM kyc_liveness_jobs WHERE id IN (
         SELECT id FROM kyc_liveness_jobs
         WHERE status <> 'pending' AND created_at < $1
         LIMIT $2
       ) RETURNING id`,
      olderThan,
    );
    const attempts = await this.deleteInBatches(
      `DELETE FROM kyc_verification_attempts WHERE id IN (
         SELECT a.id FROM kyc_verification_attempts a
         WHERE a.created_at < $1
           AND NOT EXISTS (
             SELECT 1 FROM kyc_liveness_jobs j
             WHERE j.attempt_id = a.id AND j.status = 'pending'
           )
         LIMIT $2
       ) RETURNING id`,
      olderThan,
    );
    return { livenessJobs, attempts };
  }

  private async deleteInBatches(sql: string, olderThan: Date): Promise<number> {
    let total = 0;
    let deleted: number;
    do {
      const [rows] = await this.dataSource.query<[{ id: string }[], number]>(
        sql,
        [olderThan, PRUNE_BATCH_SIZE],
      );
      deleted = rows.length;
      total += deleted;
    } while (deleted === PRUNE_BATCH_SIZE);
    return total;
  }

  // One last look before giving up, so a verdict the provider reached during a
  // long outage still counts.
  private async expireLivenessJob(job: KycLivenessJob): Promise<void> {
    if (job.providerJobId && (await this.pollLivenessJob(job))) {
      return;
    }
    await this.dataSource
      .getRepository(KycLivenessJob)
      .update({ id: job.id, status: 'pending' }, { status: 'failed' });
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

  // True once the job has been settled from the provider's answer.
  private async pollLivenessJob(job: KycLivenessJob): Promise<boolean> {
    const repo = this.dataSource.getRepository(KycLivenessJob);
    try {
      const outcome = await this.kycProvider.getLivenessResult(
        job.providerJobId!,
      );
      if (outcome === 'pending') {
        if (job.pollFailures > 0) {
          await repo.update({ id: job.id }, { pollFailures: 0 });
        }
        return false;
      }
      await this.applyLivenessOutcome(job.id, outcome);
      return true;
    } catch (error) {
      this.logger.warn(
        `Liveness poll failed for job ${job.id}: ${(error as Error).message}`,
      );
      await repo.increment({ id: job.id }, 'pollFailures', 1);
      return false;
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
    await this.checkDailyLimitLocked(manager, userId, amount, readDebitedSince);
  }

  async checkBalanceCap(
    manager: EntityManager,
    userId: string,
    requested: Money,
    readBalanceAndPending: BalanceAndPendingReader,
  ): Promise<void> {
    await this.lockUser(manager, userId);
    await this.checkBalanceCapLocked(
      manager,
      userId,
      requested,
      readBalanceAndPending,
      {
        zeroCap: () => new KycVerificationRequiredException(),
        overCap: (cap, remaining) =>
          new BalanceCapExceededException(cap, remaining),
      },
    );
  }

  // Advisory: the requester's headroom can change before anyone pays, so this
  // takes no lock and writes nothing, and a stale answer costs at worst a
  // request that later fails at payment.
  async checkCanReceive(
    manager: EntityManager,
    userId: string,
    amount: Money,
    readBalanceAndPending: BalanceAndPendingReader,
  ): Promise<void> {
    await this.checkBalanceCapLocked(
      manager,
      userId,
      amount,
      readBalanceAndPending,
      {
        zeroCap: () =>
          new KycVerificationRequiredException(
            'Verify your BVN or NIN before requesting money.',
          ),
        overCap: (cap, remaining) =>
          new BalanceCapExceededException(
            cap,
            remaining,
            `This request would take your wallet over its balance limit of ${cap.toDecimalString()}. You can request up to ${remaining.toDecimalString()} right now, counting any top-ups still in progress.`,
          ),
      },
    );
  }

  // Informational, so it takes no lock and writes nothing: the figures can be
  // stale by the time anyone acts on them, and enforcement still decides.
  async getWalletCapacity(
    manager: EntityManager,
    userId: string,
    currency: string,
    readers: {
      readDebitedSince: (manager: EntityManager, since: Date) => Promise<Money>;
      readBalanceAndPending: BalanceAndPendingReader;
    },
  ): Promise<WalletCapacity> {
    const tierLimit = await this.tierLimitFor(manager, userId, currency);
    const timeZone = this.timeZoneFor(userId);
    const dayStart = startOfDay(new Date(), timeZone);
    const dailyLimit = Money.of(tierLimit.dailyDebitLimitMinor, currency);
    const debitedToday = await readers.readDebitedSince(manager, dayStart);
    const { balance, pending } = await readers.readBalanceAndPending(manager);
    const balanceCap =
      tierLimit.balanceCapMinor === null
        ? null
        : Money.of(tierLimit.balanceCapMinor, currency);

    return {
      tier: tierLimit.tier,
      dailyLimit,
      debitedToday,
      remainingToday: remainingBelow(dailyLimit, debitedToday),
      resetsAt: startOfDay(
        new Date(dayStart.getTime() + 36 * 60 * 60 * 1000),
        timeZone,
      ),
      balanceCap,
      balance,
      pendingFunding: pending,
      headroom: balanceCap && remainingBelow(balanceCap, balance.add(pending)),
    };
  }

  // For money that has already arrived (a funding completing by webhook or
  // poll), where the answer is a decision, not an error: a breach is held
  // and refunded by the caller. Only the stored balance counts — other
  // pending fundings are checked when they complete, so counting them here
  // would hold a payment that fits. A missing tier configuration still
  // throws: that is a fault, not a verdict.
  async checkIncomingCredit(
    manager: EntityManager,
    userId: string,
    amount: Money,
    readBalance: (manager: EntityManager) => Promise<Money>,
  ): Promise<IncomingCreditVerdict> {
    await this.lockUser(manager, userId);
    return this.evaluateBalanceCapLocked(
      manager,
      userId,
      amount,
      async (m) => ({
        balance: await readBalance(m),
        pending: Money.zero(amount.currency),
      }),
    );
  }

  // A P2P transfer bounds both ends: the sender's daily limit and the
  // recipient's balance cap. Both users' locks are taken before either check.
  // The recipient's refusal reveals nothing about their tier or balance.
  async checkTransferLimits(
    manager: EntityManager,
    senderId: string,
    recipientId: string,
    amount: Money,
    readers: {
      readDebitedSince: (manager: EntityManager, since: Date) => Promise<Money>;
      readRecipientBalanceAndPending: BalanceAndPendingReader;
    },
  ): Promise<void> {
    await this.lockUsersInKeyOrder(manager, senderId, recipientId);
    await this.checkDailyLimitLocked(
      manager,
      senderId,
      amount,
      readers.readDebitedSince,
    );
    await this.checkBalanceCapLocked(
      manager,
      recipientId,
      amount,
      readers.readRecipientBalanceAndPending,
      {
        zeroCap: () => new RecipientCannotReceiveException(),
        overCap: () => new RecipientCannotReceiveException(),
      },
    );
  }

  private async checkDailyLimitLocked(
    manager: EntityManager,
    userId: string,
    amount: Money,
    readDebitedSince: (manager: EntityManager, since: Date) => Promise<Money>,
  ): Promise<void> {
    const tierLimit = await this.tierLimitFor(manager, userId, amount.currency);

    if (tierLimit.dailyDebitLimitMinor === 0n) {
      throw new KycVerificationRequiredException();
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
      throw new DailyLimitExceededException(
        dailyLimit,
        remainingBelow(dailyLimit, debited),
      );
    }
  }

  private async checkBalanceCapLocked(
    manager: EntityManager,
    userId: string,
    requested: Money,
    readBalanceAndPending: BalanceAndPendingReader,
    errors: {
      zeroCap: () => Error;
      overCap: (cap: Money, remaining: Money) => Error;
    },
  ): Promise<void> {
    const verdict = await this.evaluateBalanceCapLocked(
      manager,
      userId,
      requested,
      readBalanceAndPending,
    );
    if (verdict.allowed) {
      return;
    }
    throw verdict.reason === 'zero_cap'
      ? errors.zeroCap()
      : errors.overCap(verdict.cap, verdict.remaining);
  }

  private async evaluateBalanceCapLocked(
    manager: EntityManager,
    userId: string,
    requested: Money,
    readBalanceAndPending: BalanceAndPendingReader,
  ): Promise<IncomingCreditVerdict> {
    const tierLimit = await this.tierLimitFor(
      manager,
      userId,
      requested.currency,
    );
    if (tierLimit.balanceCapMinor === null) {
      return { allowed: true };
    }
    if (tierLimit.balanceCapMinor === 0n) {
      const zero = Money.zero(requested.currency);
      return { allowed: false, reason: 'zero_cap', cap: zero, remaining: zero };
    }

    const cap = Money.of(tierLimit.balanceCapMinor, requested.currency);
    const { balance, pending } = await readBalanceAndPending(manager);
    const projected = balance.add(pending);
    if (projected.add(requested).greaterThan(cap)) {
      const remaining = cap.greaterThan(projected)
        ? cap.subtract(projected)
        : Money.zero(requested.currency);
      return { allowed: false, reason: 'over_cap', cap, remaining };
    }
    return { allowed: true };
  }

  private async tierLimitFor(
    manager: EntityManager,
    userId: string,
    currency: string,
  ): Promise<TierLimit> {
    const tier = await this.usersService.getKycTier(manager, userId);
    const tierLimit = await manager
      .getRepository(TierLimit)
      .findOneBy({ tier, currency });
    if (!tierLimit) {
      throw new TierLimitNotConfiguredException();
    }
    return tierLimit;
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
    const tierLimit = await this.dataSource
      .getRepository(TierLimit)
      .findOneBy({ tier: user.kycTier, currency: STATUS_CURRENCY });
    if (!tierLimit) {
      throw new TierLimitNotConfiguredException();
    }

    return {
      tier: user.kycTier,
      bvnVerified: !!record?.bvnHash,
      ninVerified: !!record?.ninHash,
      livenessVerified: record?.livenessVerified ?? false,
      livenessPending: pendingJobs > 0,
      dailyDebitLimit: Money.of(
        tierLimit.dailyDebitLimitMinor,
        STATUS_CURRENCY,
      ).toJSON(),
      balanceCap:
        tierLimit.balanceCapMinor === null
          ? null
          : Money.of(tierLimit.balanceCapMinor, STATUS_CURRENCY).toJSON(),
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

  // Ordered by the lock key itself, not by user id: two ids can hash to the
  // same key, and any other order lets A->B and B->A each hold one lock and
  // wait for the other. Equal keys are taken once.
  private async lockUsersInKeyOrder(
    manager: EntityManager,
    firstUserId: string,
    secondUserId: string,
  ): Promise<void> {
    const [row] = await manager.query<{ a: number; b: number }[]>(
      'SELECT hashtext($1) AS a, hashtext($2) AS b',
      [firstUserId, secondUserId],
    );
    const keys = [...new Set([row.a, row.b])].sort((x, y) => x - y);
    for (const key of keys) {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [key]);
    }
  }
}
