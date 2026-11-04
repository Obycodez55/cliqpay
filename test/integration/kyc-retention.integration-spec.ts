import { randomUUID } from 'crypto';
import { Job } from 'bullmq';
import {
  KycTestContext,
  createKycTestContext,
  destroyKycTestContext,
  seedKycUser,
} from './support/kyc-test-context';
import { KycRetentionProcessor } from '../../src/modules/kyc/internal/kyc-retention.processor';
import {
  BvnVerificationFailedException,
  TooManyVerificationAttemptsException,
} from '../../src/modules/kyc/internal/errors';

jest.setTimeout(180_000);

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

describe('KYC bookkeeping retention', () => {
  let ctx: KycTestContext;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createKycTestContext();
  });

  afterAll(async () => {
    await destroyKycTestContext(ctx);
  });

  beforeEach(async () => {
    await ctx.dataSource.query(
      'TRUNCATE kyc_liveness_jobs, kyc_verification_attempts',
    );
  });

  const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
  const cutoff = () => ago(RETENTION_DAYS);

  async function seedUser(): Promise<string> {
    seq += 1;
    const { userId } = await seedKycUser(ctx, {
      email: `retention-${seq}@example.com`,
      phone: `+2348055${String(500_000 + seq).padStart(6, '0')}`,
      username: `retention_user_${seq}`,
    });
    return userId;
  }

  async function seedAttempt(
    userId: string,
    createdAt: Date,
    succeeded = false,
  ): Promise<string> {
    const id = randomUUID();
    await ctx.dataSource.query(
      `INSERT INTO kyc_verification_attempts
         (id, user_id, identity_type, succeeded, created_at)
       VALUES ($1, $2, 'bvn', $3, $4)`,
      [id, userId, succeeded, createdAt],
    );
    return id;
  }

  async function seedJob(
    userId: string,
    attemptId: string,
    status: 'pending' | 'passed' | 'failed',
    createdAt: Date,
  ): Promise<string> {
    const id = randomUUID();
    await ctx.dataSource.query(
      `INSERT INTO kyc_liveness_jobs
         (id, user_id, attempt_id, identity_type, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'bvn', $4, $5, $5)`,
      [id, userId, attemptId, status, createdAt],
    );
    return id;
  }

  const ids = async (table: string) =>
    (
      await ctx.dataSource.query<{ id: string }[]>(`SELECT id FROM ${table}`)
    ).map((r) => r.id);

  it('deletes attempts older than the retention and keeps newer ones, including those past the rate-limit window', async () => {
    const userId = await seedUser();
    const old = await seedAttempt(userId, ago(RETENTION_DAYS + 1));
    const pastWindow = await seedAttempt(userId, ago(2));
    const recent = await seedAttempt(userId, ago(0));

    const result = await ctx.kycService.pruneBookkeeping(cutoff());

    expect(result.attempts).toBe(1);
    const remaining = await ids('kyc_verification_attempts');
    expect(remaining).not.toContain(old);
    expect(remaining).toEqual(expect.arrayContaining([pastWindow, recent]));
  });

  it('deletes settled liveness jobs older than the retention and keeps newer ones', async () => {
    const userId = await seedUser();
    const otherUser = await seedUser();
    const recentAttempt = await seedAttempt(userId, ago(1));
    const oldPassed = await seedJob(
      userId,
      recentAttempt,
      'passed',
      ago(RETENTION_DAYS + 1),
    );
    const oldFailed = await seedJob(
      otherUser,
      recentAttempt,
      'failed',
      ago(RETENTION_DAYS + 1),
    );
    const recentPassed = await seedJob(userId, recentAttempt, 'passed', ago(1));

    const result = await ctx.kycService.pruneBookkeeping(cutoff());

    expect(result.livenessJobs).toBe(2);
    const remaining = await ids('kyc_liveness_jobs');
    expect(remaining).toEqual([recentPassed]);
    expect(remaining).not.toContain(oldPassed);
    expect(remaining).not.toContain(oldFailed);
  });

  it('never deletes a pending liveness job, nor the attempt it belongs to, however old', async () => {
    const pendingUser = await seedUser();
    const settledUser = await seedUser();
    const pendingAttempt = await seedAttempt(pendingUser, ago(40));
    const pendingJob = await seedJob(
      pendingUser,
      pendingAttempt,
      'pending',
      ago(40),
    );
    const settledAttempt = await seedAttempt(settledUser, ago(40));
    await seedJob(settledUser, settledAttempt, 'failed', ago(40));

    await ctx.kycService.pruneBookkeeping(cutoff());

    expect(await ids('kyc_liveness_jobs')).toEqual([pendingJob]);
    expect(await ids('kyc_verification_attempts')).toEqual([pendingAttempt]);
  });

  it('cascades from a deleted attempt to its job, leaving no orphan', async () => {
    const userId = await seedUser();
    const attempt = await seedAttempt(userId, ago(RETENTION_DAYS + 5));
    await seedJob(userId, attempt, 'passed', ago(1));

    await ctx.kycService.pruneBookkeeping(cutoff());

    expect(await ids('kyc_verification_attempts')).toEqual([]);
    expect(await ids('kyc_liveness_jobs')).toEqual([]);
    const orphans = await ctx.dataSource.query<{ n: string }[]>(
      `SELECT count(*) AS n FROM kyc_liveness_jobs j
       LEFT JOIN kyc_verification_attempts a ON a.id = j.attempt_id
       WHERE a.id IS NULL`,
    );
    expect(orphans[0].n).toBe('0');
  });

  it('works through a backlog larger than one batch', async () => {
    const userId = await seedUser();
    await ctx.dataSource.query(
      `INSERT INTO kyc_verification_attempts
         (user_id, identity_type, succeeded, created_at)
       SELECT $1, 'bvn', false, $2 FROM generate_series(1, 2500)`,
      [userId, ago(RETENTION_DAYS + 1)],
    );
    const kept = await seedAttempt(userId, ago(1));

    const result = await ctx.kycService.pruneBookkeeping(cutoff());

    expect(result.attempts).toBe(2500);
    expect(await ids('kyc_verification_attempts')).toEqual([kept]);
  });

  it('keeps the failed-attempt rate limit working at the edge of the 24-hour window after pruning', async () => {
    const userId = await seedUser();
    const inside = ago(1 - 10 / 60 / 24);
    for (let i = 0; i < 5; i += 1) {
      await seedAttempt(userId, inside);
    }
    await ctx.kycService.pruneBookkeeping(cutoff());

    expect(await ctx.kycVerificationAttemptRepo.countBy({ userId })).toBe(5);
    await expect(
      ctx.kycService.verifyBvn(userId, '12345678901'),
    ).rejects.toBeInstanceOf(TooManyVerificationAttemptsException);

    await ctx.dataSource.query(
      `UPDATE kyc_verification_attempts
       SET created_at = now() - interval '24 hours 10 minutes'
       WHERE user_id = $1`,
      [userId],
    );
    await ctx.kycService.pruneBookkeeping(cutoff());

    expect(await ctx.kycVerificationAttemptRepo.countBy({ userId })).toBe(5);
    await expect(
      ctx.kycService.verifyBvn(userId, '00000000001'),
    ).rejects.toBeInstanceOf(BvnVerificationFailedException);
  });

  it('prunes through the scheduled processor using the configured retention', async () => {
    const userId = await seedUser();
    const old = await seedAttempt(userId, ago(RETENTION_DAYS + 1));
    const kept = await seedAttempt(userId, ago(RETENTION_DAYS - 1));
    const processor = ctx.app.get(KycRetentionProcessor);

    await processor.process({} as Job);

    const remaining = await ids('kyc_verification_attempts');
    expect(remaining).not.toContain(old);
    expect(remaining).toContain(kept);
  });
});
