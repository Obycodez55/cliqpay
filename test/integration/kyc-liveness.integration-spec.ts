import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import {
  KycTestContext,
  createKycTestContext,
  destroyKycTestContext,
  seedKycUser,
} from './support/kyc-test-context';
import { TEST_JWT_SECRET } from './support/test-app-config';

jest.setTimeout(180_000);

// FakeKycProvider sentinels, by ID-number prefix: 2222 fails liveness, 3333 is
// asynchronous and passes on the first poll, 4444 is asynchronous and stays
// pending, 5555 is asynchronous and fails on the first poll, 6666 errors.
// Every other prefix passes liveness synchronously.
const PASS = '7777';
const FAIL = '2222';
const ASYNC_PASS = '3333';
const ASYNC_PENDING = '4444';
const ASYNC_FAIL = '5555';
const ERROR = '6666';

const JPEG = '/9j/AAAA';
const SELFIE_MARKER = 'SELFIEMARKERabcd1234';

function capture(overrides: Record<string, unknown> = {}) {
  return {
    selfieImage: JPEG,
    livenessImages: Array<string>(6).fill(JPEG),
    consentGranted: true,
    ...overrides,
  };
}

describe('KYC liveness (Tier 3)', () => {
  let ctx: KycTestContext;
  let jwtService: JwtService;
  let userSeq = 0;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createKycTestContext();
    jwtService = new JwtService({ secret: TEST_JWT_SECRET });
    await ctx.app.listen(0);
  });

  afterAll(async () => {
    await destroyKycTestContext(ctx);
  });

  async function seedUser() {
    userSeq += 1;
    const n = userSeq;
    const { userId } = await seedKycUser(ctx, {
      email: `liveness-${n}@example.com`,
      phone: `+2348066${String(400_000 + n).padStart(6, '0')}`,
      username: `liveness_user_${n}`,
    });
    return { userId, token: jwtService.sign({ sub: userId, sid: 's' }) };
  }

  function id(prefix: string): string {
    idSeq += 1;
    return prefix + String(idSeq).padStart(7, '0');
  }

  function verify(
    token: string,
    kind: 'bvn' | 'nin',
    idNumber: string,
    liveness?: Record<string, unknown>,
  ) {
    return request(ctx.app.getHttpServer())
      .post(`/kyc/verify-${kind}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ [kind]: idNumber, ...(liveness ? { liveness } : {}) });
  }

  function status(token: string) {
    return request(ctx.app.getHttpServer())
      .get('/kyc/status')
      .set('Authorization', `Bearer ${token}`);
  }

  async function userTier(userId: string) {
    return (await ctx.userRepo.findOneByOrFail({ id: userId })).kycTier;
  }

  describe('tier 3 in every ordering', () => {
    it('BVN + selfie, then NIN', async () => {
      const { userId, token } = await seedUser();

      const first = await verify(token, 'bvn', id(PASS), capture());
      expect(first.status).toBe(201);
      expect(first.body).toEqual({
        tier: 'tier1',
        bvnVerified: true,
        ninVerified: false,
        livenessVerified: true,
        livenessResult: 'passed',
      });

      const second = await verify(token, 'nin', id(PASS));
      expect(second.body).toMatchObject({
        tier: 'tier3',
        livenessVerified: true,
        livenessResult: 'not_requested',
      });
      expect(await userTier(userId)).toBe('tier3');
    });

    it('NIN, then BVN + selfie', async () => {
      const { userId, token } = await seedUser();

      await verify(token, 'nin', id(PASS));
      const res = await verify(token, 'bvn', id(PASS), capture());

      expect(res.body).toMatchObject({
        tier: 'tier3',
        livenessResult: 'passed',
      });
      expect(await userTier(userId)).toBe('tier3');
    });

    it('NIN + selfie, then BVN', async () => {
      const { userId, token } = await seedUser();

      await verify(token, 'nin', id(PASS), capture());
      const res = await verify(token, 'bvn', id(PASS));

      expect(res.body).toMatchObject({ tier: 'tier3', livenessVerified: true });
      expect(await userTier(userId)).toBe('tier3');
    });

    it('BVN, NIN, then the same BVN + selfie attaches liveness without touching identity fields', async () => {
      const { userId, token } = await seedUser();
      const bvn = id(PASS);
      await verify(token, 'bvn', bvn);
      await verify(token, 'nin', id(PASS));
      expect(await userTier(userId)).toBe('tier2');
      const before = await ctx.kycVerificationRepo.findOneByOrFail({ userId });

      const res = await verify(token, 'bvn', bvn, capture());

      expect(res.body).toMatchObject({
        tier: 'tier3',
        livenessVerified: true,
        livenessResult: 'passed',
      });
      const after = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
      expect({ ...after, livenessVerified: false, updatedAt: null }).toEqual({
        ...before,
        updatedAt: null,
      });
      expect(after.livenessVerified).toBe(true);
    });
  });

  describe('failed liveness', () => {
    it('keeps a first-time identity, raises the tier, and reports the failure', async () => {
      const { userId, token } = await seedUser();

      const res = await verify(token, 'bvn', id(FAIL), capture());

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        tier: 'tier1',
        bvnVerified: true,
        ninVerified: false,
        livenessVerified: false,
        livenessResult: 'failed',
      });
      expect(await userTier(userId)).toBe('tier1');
      expect((await status(token)).body).toMatchObject({
        bvnVerified: true,
        livenessVerified: false,
        livenessPending: false,
      });
      const attempts = await ctx.kycVerificationAttemptRepo.findBy({ userId });
      expect(attempts.map((a) => a.succeeded)).toEqual([false]);
    });

    it('counts each failed liveness retry toward the 5-per-24h limit', async () => {
      const { token } = await seedUser();
      const bvn = id(FAIL);

      const results: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        results.push((await verify(token, 'bvn', bvn, capture())).status);
      }
      const sixth = await verify(token, 'bvn', bvn, capture());

      expect(results).toEqual([201, 201, 201, 201, 201]);
      expect(sixth.status).toBe(429);
    });

    it('a passing selfie on the other identifier completes tier 3 after a failed one', async () => {
      const { userId, token } = await seedUser();
      await verify(token, 'bvn', id(FAIL), capture());
      expect(await userTier(userId)).toBe('tier1');

      const res = await verify(token, 'nin', id(PASS), capture());

      expect(res.body).toMatchObject({
        tier: 'tier3',
        livenessVerified: true,
        livenessResult: 'passed',
      });
      expect(await userTier(userId)).toBe('tier3');
    });
  });

  describe('immutability and the free no-op', () => {
    it('a same-identifier call with a selfie is free once liveness is verified', async () => {
      const { userId, token } = await seedUser();
      const bvn = id(PASS);
      await verify(token, 'bvn', bvn, capture());
      const attemptsBefore = await ctx.kycVerificationAttemptRepo.countBy({
        userId,
      });

      const res = await verify(token, 'bvn', bvn, capture());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        livenessVerified: true,
        livenessResult: 'passed',
      });
      expect(await ctx.kycVerificationAttemptRepo.countBy({ userId })).toBe(
        attemptsBefore,
      );
      expect(await ctx.kycLivenessJobRepo.countBy({ userId })).toBe(1);
    });

    it('a different identifier with a selfie is still a 409', async () => {
      const { token } = await seedUser();
      await verify(token, 'bvn', id(PASS));

      const res = await verify(token, 'bvn', id(PASS), capture());

      expect(res.status).toBe(409);
    });
  });

  describe('request validation', () => {
    it.each([
      ['a non-base64 selfie', { selfieImage: 'not base64!!' }],
      ['a non-JPEG selfie', { selfieImage: 'aGVsbG8=' }],
      ['an oversized selfie', { selfieImage: '/9j/' + 'A'.repeat(1_000_000) }],
      ['too few liveness frames', { livenessImages: Array(5).fill(JPEG) }],
      ['too many liveness frames', { livenessImages: Array(9).fill(JPEG) }],
      ['missing consent', { consentGranted: false }],
      ['an unknown field', { extra: 'x' }],
    ])('rejects %s with a 400', async (_label, overrides) => {
      const { userId, token } = await seedUser();

      const res = await verify(token, 'bvn', id(PASS), capture(overrides));

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('not base64');
      expect(await ctx.kycVerificationAttemptRepo.countBy({ userId })).toBe(0);
    });

    it('accepts a multi-megabyte capture on the verify routes only', async () => {
      const { token } = await seedUser();
      const large = '/9j/' + 'A'.repeat(700_000);

      const accepted = await verify(
        token,
        'nin',
        id(PASS),
        capture({ selfieImage: large, livenessImages: Array(7).fill(large) }),
      );
      const rejected = await request(ctx.app.getHttpServer())
        .post('/kyc/other')
        .set('Authorization', `Bearer ${token}`)
        .send({ padding: 'x'.repeat(1_100_000) });

      expect(accepted.status).toBe(201);
      expect(rejected.status).toBe(413);
    });
  });

  describe('asynchronous providers', () => {
    it('reports pending, blocks a second submission, and settles on the next poll', async () => {
      const { userId, token } = await seedUser();
      const bvn = id(ASYNC_PASS);

      const res = await verify(token, 'bvn', bvn, capture());
      expect(res.body).toMatchObject({
        tier: 'tier1',
        livenessVerified: false,
        livenessResult: 'pending',
      });
      const pendingStatus = await status(token);
      expect(pendingStatus.body).toMatchObject({ livenessPending: true });

      const again = await verify(token, 'bvn', bvn, capture());
      expect(again.status).toBe(409);

      await ctx.kycService.pollPendingLivenessJobs();

      const settled = await status(token);
      expect(settled.body).toMatchObject({
        livenessVerified: true,
        livenessPending: false,
      });
      const attempts = await ctx.kycVerificationAttemptRepo.findBy({ userId });
      expect(attempts.map((a) => a.succeeded)).toEqual([true]);

      const nin = await verify(token, 'nin', id(PASS));
      expect(nin.body).toMatchObject({ tier: 'tier3' });
    });

    it('settles a pending job from a webhook that names it, ignoring the body', async () => {
      const { userId, token } = await seedUser();
      await verify(token, 'bvn', id(ASYNC_PASS), capture());
      const job = await ctx.kycLivenessJobRepo.findOneByOrFail({ userId });

      const webhook = await request(ctx.app.getHttpServer())
        .post('/kyc/webhook')
        .send({ jobId: job.providerJobId, status: 'block' });

      expect(webhook.status).toBe(200);
      expect((await status(token)).body).toMatchObject({
        livenessVerified: true,
      });
    });

    it('leaves liveness unverified and the attempt failed when the polled result is a failure', async () => {
      const { userId, token } = await seedUser();
      await verify(token, 'bvn', id(ASYNC_FAIL), capture());

      await ctx.kycService.pollPendingLivenessJobs();

      expect((await status(token)).body).toMatchObject({
        bvnVerified: true,
        livenessVerified: false,
        livenessPending: false,
      });
      const attempts = await ctx.kycVerificationAttemptRepo.findBy({ userId });
      expect(attempts.map((a) => a.succeeded)).toEqual([false]);
    });

    it('expires a job the provider never settles', async () => {
      const { userId, token } = await seedUser();
      const bvn = id(ASYNC_PENDING);
      await verify(token, 'bvn', bvn, capture());
      await ctx.kycLivenessJobRepo.update(
        { userId },
        { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      );

      await ctx.kycService.pollPendingLivenessJobs();

      expect((await status(token)).body).toMatchObject({
        livenessPending: false,
        livenessVerified: false,
      });
      const retry = await verify(token, 'bvn', bvn, capture());
      expect(retry.status).toBe(201);
      expect(retry.body).toMatchObject({ livenessResult: 'pending' });
    });

    it('ignores a webhook for an unknown job', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/kyc/webhook')
        .send({ jobId: 'nope' });

      expect(res.status).toBe(200);
    });
  });

  describe('provider errors', () => {
    it('releases the attempt and the job slot but keeps the persisted identity', async () => {
      const { userId, token } = await seedUser();

      const res = await verify(token, 'bvn', id(ERROR), capture());

      expect(res.status).toBe(500);
      expect(await ctx.kycVerificationAttemptRepo.countBy({ userId })).toBe(0);
      expect(await ctx.kycLivenessJobRepo.countBy({ userId })).toBe(0);
      expect((await status(token)).body).toMatchObject({ bvnVerified: true });
    });
  });

  describe('concurrency', () => {
    it('BVN + selfie and NIN requested together end at tier3', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { userId, token } = await seedUser();

        const [bvn, nin] = await Promise.all([
          verify(token, 'bvn', id(PASS), capture()),
          verify(token, 'nin', id(PASS)),
        ]);

        expect([bvn.status, nin.status]).toEqual([201, 201]);
        expect(await userTier(userId)).toBe('tier3');
        expect((await status(token)).body).toMatchObject({
          bvnVerified: true,
          ninVerified: true,
          livenessVerified: true,
        });
      }
    });

    it('two simultaneous selfie submissions yield one provider job and one 409', async () => {
      const { userId, token } = await seedUser();
      const bvn = id(ASYNC_PENDING);
      await verify(token, 'bvn', bvn);

      const results = await Promise.all([
        verify(token, 'bvn', bvn, capture()),
        verify(token, 'bvn', bvn, capture()),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await ctx.kycLivenessJobRepo.countBy({ userId })).toBe(1);
    });
  });

  describe('selfie handling', () => {
    it('never reaches any persisted row', async () => {
      const { token } = await seedUser();
      const marked = '/9j/' + SELFIE_MARKER;
      await verify(
        token,
        'bvn',
        id(PASS),
        capture({ selfieImage: marked, livenessImages: Array(6).fill(marked) }),
      );

      for (const table of [
        'kyc_verifications',
        'kyc_verification_attempts',
        'kyc_liveness_jobs',
        'users',
      ]) {
        const rows: unknown[] = await ctx.dataSource.query(
          `SELECT row_to_json(t)::text AS r FROM "${table}" t`,
        );
        expect(JSON.stringify(rows)).not.toContain(SELFIE_MARKER);
      }
    });
  });
});
