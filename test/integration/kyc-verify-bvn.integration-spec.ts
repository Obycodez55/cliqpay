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

describe('POST /kyc/verify-bvn, GET /kyc/status', () => {
  let ctx: KycTestContext;
  let jwtService: JwtService;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createKycTestContext();
    jwtService = new JwtService({ secret: TEST_JWT_SECRET });
  });

  afterAll(async () => {
    await destroyKycTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  function nextIdentity(prefix: string) {
    idSeq += 1;
    const n = idSeq;
    return {
      email: `${prefix}-${n}@example.com`,
      phone: `+2348044${String(300_000 + n).padStart(6, '0')}`,
      username: `${prefix}_user_${n}`,
    };
  }

  async function seedUser() {
    const identity = nextIdentity('kyc');
    const { userId } = await seedKycUser(ctx, identity);
    return userId;
  }

  function verifyBvn(token: string | undefined, bvn: string) {
    const req = request(ctx.app.getHttpServer()).post('/kyc/verify-bvn');
    if (token !== undefined) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req.send({ bvn });
  }

  function getStatus(token: string) {
    return request(ctx.app.getHttpServer())
      .get('/kyc/status')
      .set('Authorization', `Bearer ${token}`);
  }

  it('rejects an unauthenticated request', async () => {
    const res = await verifyBvn(undefined, '12345678901');
    expect(res.status).toBe(401);
  });

  it('verifies a BVN and upgrades a tier0 user to tier1', async () => {
    const userId = await seedUser();
    const token = tokenFor(userId);

    const res = await verifyBvn(token, '12345678901');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      tier: 'tier1',
      bvnVerified: true,
      ninVerified: false,
      livenessVerified: false,
    });

    const user = await ctx.userRepo.findOneByOrFail({ id: userId });
    expect(user.kycTier).toBe('tier1');

    const statusRes = await getStatus(token);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toEqual({
      tier: 'tier1',
      bvnVerified: true,
      ninVerified: false,
      livenessVerified: false,
      dailyAllowanceRemainingMinor: 0,
    });
  });

  it('stores the BVN address under address.bvn and keeps an existing address.nin', async () => {
    const userId = await seedUser();
    const ninAddress = {
      street: '2 Other St',
      town: 'Yaba',
      lga: 'Yaba',
      state: 'Lagos',
    };
    await ctx.kycVerificationRepo.insert({
      userId,
      address: { nin: ninAddress },
    });

    await verifyBvn(tokenFor(userId), '66677788899').expect(201);

    const record = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
    expect(record.address).toEqual({
      bvn: {
        street: '1 Test Street',
        town: 'Ikeja',
        lga: 'Ikeja',
        state: 'Lagos',
      },
      nin: ninAddress,
    });
  });

  it('returns tier0 defaults from GET /kyc/status before any verification', async () => {
    const userId = await seedUser();
    const res = await getStatus(tokenFor(userId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tier: 'tier0',
      bvnVerified: false,
      ninVerified: false,
      livenessVerified: false,
      dailyAllowanceRemainingMinor: 0,
    });
  });

  it('rejects a BVN the provider cannot verify, persisting nothing', async () => {
    const userId = await seedUser();

    const res = await verifyBvn(tokenFor(userId), '00000000001');

    expect(res.status).toBe(422);
    const user = await ctx.userRepo.findOneByOrFail({ id: userId });
    expect(user.kycTier).toBe('tier0');
    const record = await ctx.kycVerificationRepo.findOneBy({ userId });
    expect(record).toBeNull();
  });

  it('rejects a BVN already linked to another user, persisting nothing new', async () => {
    const firstUserId = await seedUser();
    await verifyBvn(tokenFor(firstUserId), '11122233344').expect(201);

    const secondUserId = await seedUser();
    const res = await verifyBvn(tokenFor(secondUserId), '11122233344');

    expect(res.status).toBe(409);
    const secondUser = await ctx.userRepo.findOneByOrFail({ id: secondUserId });
    expect(secondUser.kycTier).toBe('tier0');
    const record = await ctx.kycVerificationRepo.findOneBy({
      userId: secondUserId,
    });
    expect(record).toBeNull();
  });

  it('rejects verification after 5 failed attempts within the rolling window', async () => {
    const userId = await seedUser();
    const token = tokenFor(userId);

    for (let i = 0; i < 5; i += 1) {
      const res = await verifyBvn(token, '00000000001');
      expect(res.status).toBe(422);
    }

    const res = await verifyBvn(token, '99988877766');
    expect(res.status).toBe(429);

    const attempts = await ctx.kycVerificationAttemptRepo.count({
      where: { userId },
    });
    expect(attempts).toBe(5);
  });

  describe('verified BVN immutability', () => {
    it('treats resubmitting the same BVN as a free no-op and rejects a different one', async () => {
      const userId = await seedUser();
      const token = tokenFor(userId);
      await verifyBvn(token, '71000000001').expect(201);
      const before = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
      const attemptsBefore = await ctx.kycVerificationAttemptRepo.countBy({
        userId,
      });

      const same = await verifyBvn(token, '71000000001');
      expect(same.status).toBe(201);
      expect(same.body).toEqual({
        tier: 'tier1',
        bvnVerified: true,
        ninVerified: false,
        livenessVerified: false,
      });

      const different = await verifyBvn(token, '71000000002');
      expect(different.status).toBe(409);

      const after = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
      expect(after).toEqual(before);
      expect(await ctx.kycVerificationAttemptRepo.countBy({ userId })).toBe(
        attemptsBefore,
      );
      const user = await ctx.userRepo.findOneByOrFail({ id: userId });
      expect(user.kycTier).toBe('tier1');
    });

    it('does not free the old BVN for another account by overwriting it', async () => {
      const userA = await seedUser();
      const userB = await seedUser();
      await verifyBvn(tokenFor(userA), '72000000001').expect(201);

      expect((await verifyBvn(tokenFor(userA), '72000000002')).status).toBe(
        409,
      );
      const res = await verifyBvn(tokenFor(userB), '72000000001');

      expect(res.status).toBe(409);
      expect(await ctx.kycVerificationRepo.findOneBy({ userId: userB })).toBe(
        null,
      );
    });
  });

  describe('concurrency', () => {
    beforeAll(async () => {
      await ctx.app.listen(0);
    });

    it('serializes concurrent first-time verifications for one user: the first wins, the rest are rejected, with no 500', async () => {
      const userId = await seedUser();
      const token = tokenFor(userId);

      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          verifyBvn(token, String(20_000_000_000 + i)),
        ),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(4);
      expect(await ctx.kycVerificationRepo.countBy({ userId })).toBe(1);
      const user = await ctx.userRepo.findOneByOrFail({ id: userId });
      expect(user.kycTier).toBe('tier1');
    });

    it('blocks on the per-user advisory lock until another transaction releases it', async () => {
      const userId = await seedUser();
      const queryRunner = ctx.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await queryRunner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        userId,
      ]);

      let settled = false;
      const pending = verifyBvn(tokenFor(userId), '55566677788').then((res) => {
        settled = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      await queryRunner.commitTransaction();
      await queryRunner.release();
      expect((await pending).status).toBe(201);
    });

    it('counts concurrent failing attempts before they reach the provider, capping them at 5 out of a burst of 30', async () => {
      const userId = await seedUser();
      const token = tokenFor(userId);

      const responses = await Promise.all(
        Array.from({ length: 30 }, () => verifyBvn(token, '00000000001')),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 422)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(25);
      expect(await ctx.kycVerificationAttemptRepo.countBy({ userId })).toBe(5);
    });
  });
});

describe('tier_limits (seeded reference data)', () => {
  let ctx: KycTestContext;

  beforeAll(async () => {
    ctx = await createKycTestContext();
  });

  afterAll(async () => {
    await destroyKycTestContext(ctx);
  });

  it('reads back the seeded NGN tier limits via the TierLimit entity', async () => {
    const rows = await ctx.tierLimitRepo.find({ where: { currency: 'NGN' } });
    const byTier = new Map(rows.map((row) => [row.tier, row]));

    expect(byTier.get('tier0')).toMatchObject({
      dailyDebitLimitMinor: 0n,
      balanceCapMinor: 0n,
    });
    expect(byTier.get('tier1')).toMatchObject({
      dailyDebitLimitMinor: 5_000_000n,
      balanceCapMinor: 30_000_000n,
    });
    expect(byTier.get('tier2')).toMatchObject({
      dailyDebitLimitMinor: 20_000_000n,
      balanceCapMinor: 50_000_000n,
    });
    expect(byTier.get('tier3')).toMatchObject({
      dailyDebitLimitMinor: 500_000_000n,
      balanceCapMinor: null,
    });
  });
});
