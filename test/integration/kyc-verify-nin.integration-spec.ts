import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import {
  KycTestContext,
  createKycTestContext,
  destroyKycTestContext,
  seedKycUser,
} from './support/kyc-test-context';
import {
  TEST_ENCRYPTION_KEY,
  TEST_IDENTIFIER_HASH_KEY,
  TEST_JWT_SECRET,
} from './support/test-app-config';
import {
  encryptionKeyFromHex,
  hmacHex,
} from '../../src/shared/crypto/secrets.util';

jest.setTimeout(180_000);

describe('POST /kyc/verify-nin, Tier 2 derivation', () => {
  let ctx: KycTestContext;
  let jwtService: JwtService;
  let idSeq = 0;

  beforeAll(async () => {
    ctx = await createKycTestContext();
    jwtService = new JwtService({ secret: TEST_JWT_SECRET });
    await ctx.app.listen(0);
  });

  afterAll(async () => {
    await destroyKycTestContext(ctx);
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({ sub: userId, sid: 'test-session' });
  }

  async function seedUser() {
    idSeq += 1;
    const n = idSeq;
    const { userId } = await seedKycUser(ctx, {
      email: `nin-${n}@example.com`,
      phone: `+2348055${String(300_000 + n).padStart(6, '0')}`,
      username: `nin_user_${n}`,
    });
    return userId;
  }

  function verifyNin(token: string | undefined, nin: string) {
    const req = request(ctx.app.getHttpServer()).post('/kyc/verify-nin');
    if (token !== undefined) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req.send({ nin });
  }

  function verifyBvn(token: string, bvn: string) {
    return request(ctx.app.getHttpServer())
      .post('/kyc/verify-bvn')
      .set('Authorization', `Bearer ${token}`)
      .send({ bvn });
  }

  function getStatus(token: string) {
    return request(ctx.app.getHttpServer())
      .get('/kyc/status')
      .set('Authorization', `Bearer ${token}`);
  }

  it('rejects an unauthenticated request', async () => {
    const res = await verifyNin(undefined, '12345678901');
    expect(res.status).toBe(401);
  });

  it('rejects a NIN that is not 11 digits', async () => {
    const userId = await seedUser();
    const res = await verifyNin(tokenFor(userId), '1234');
    expect(res.status).toBe(400);
  });

  it('verifies a NIN, persists it with its address and legal name, and upgrades a tier0 user to tier1', async () => {
    const userId = await seedUser();
    const token = tokenFor(userId);

    const res = await verifyNin(token, '12345678901');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      tier: 'tier1',
      bvnVerified: false,
      ninVerified: true,
      livenessVerified: false,
      livenessResult: 'not_requested',
    });

    const record = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
    expect(record.ninHash).toBe(
      hmacHex('12345678901', encryptionKeyFromHex(TEST_IDENTIFIER_HASH_KEY)),
    );
    expect(record.ninHash).not.toBe(
      hmacHex('12345678901', encryptionKeyFromHex(TEST_ENCRYPTION_KEY)),
    );
    expect(record.ninCiphertext).toEqual(expect.any(String));
    expect(record.ninCiphertext).not.toContain('12345678901');
    expect(record.bvnHash).toBeNull();
    expect(record.verifiedLegalName).toBe('Lovelace Ada');
    expect(record.address).toEqual({
      nin: {
        street: '1 Test Street',
        town: 'Ikeja',
        lga: 'Ikeja',
        state: 'Lagos',
      },
    });

    const statusRes = await getStatus(token);
    expect(statusRes.body).toEqual({
      tier: 'tier1',
      bvnVerified: false,
      ninVerified: true,
      livenessVerified: false,
      livenessPending: false,
      dailyDebitLimit: { amount: '5000000', currency: 'NGN' },
      balanceCap: { amount: '30000000', currency: 'NGN' },
    });
  });

  it('reaches tier2 when the NIN is verified first and the BVN second', async () => {
    const userId = await seedUser();
    const token = tokenFor(userId);

    await verifyNin(token, '30000000001').expect(201);
    const res = await verifyBvn(token, '30000000002');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      tier: 'tier2',
      bvnVerified: true,
      ninVerified: true,
      livenessVerified: false,
      livenessResult: 'not_requested',
    });
    const user = await ctx.userRepo.findOneByOrFail({ id: userId });
    expect(user.kycTier).toBe('tier2');
    const record = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
    expect(Object.keys(record.address ?? {}).sort()).toEqual(['bvn', 'nin']);
    expect(record.verifiedLegalName).toBe('Ada Obi Lovelace');
  });

  it('reaches tier2 when the BVN is verified first and the NIN second', async () => {
    const userId = await seedUser();
    const token = tokenFor(userId);

    await verifyBvn(token, '31000000001').expect(201);
    const res = await verifyNin(token, '31000000002');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tier: 'tier2',
      bvnVerified: true,
      ninVerified: true,
    });
    const statusRes = await getStatus(token);
    expect(statusRes.body).toMatchObject({
      tier: 'tier2',
      bvnVerified: true,
      ninVerified: true,
    });
    const record = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
    expect(record.verifiedLegalName).toBe('Ada Obi Lovelace');
  });

  it('ends at tier2 when BVN and NIN verification run concurrently for the same user', async () => {
    for (let round = 0; round < 3; round += 1) {
      const userId = await seedUser();
      const token = tokenFor(userId);

      const [bvnRes, ninRes] = await Promise.all([
        verifyBvn(token, `4${round}000000001`),
        verifyNin(token, `4${round}000000002`),
      ]);

      expect(bvnRes.status).toBe(201);
      expect(ninRes.status).toBe(201);
      expect(await ctx.kycVerificationRepo.countBy({ userId })).toBe(1);
      const user = await ctx.userRepo.findOneByOrFail({ id: userId });
      expect(user.kycTier).toBe('tier2');
      const record = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
      expect(record.bvnHash).not.toBeNull();
      expect(record.ninHash).not.toBeNull();
      expect(record.verifiedLegalName).toBe('Ada Obi Lovelace');
    }
  });

  it('rejects a NIN the provider cannot verify, persisting nothing', async () => {
    const userId = await seedUser();

    const res = await verifyNin(tokenFor(userId), '00000000001');

    expect(res.status).toBe(422);
    const user = await ctx.userRepo.findOneByOrFail({ id: userId });
    expect(user.kycTier).toBe('tier0');
    expect(await ctx.kycVerificationRepo.findOneBy({ userId })).toBeNull();
  });

  it('rejects a NIN already linked to another user, persisting nothing new', async () => {
    const firstUserId = await seedUser();
    await verifyNin(tokenFor(firstUserId), '50000000001').expect(201);

    const secondUserId = await seedUser();
    const res = await verifyNin(tokenFor(secondUserId), '50000000001');

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toContain(
      'NIN is already linked',
    );
    const secondUser = await ctx.userRepo.findOneByOrFail({ id: secondUserId });
    expect(secondUser.kycTier).toBe('tier0');
    expect(
      await ctx.kycVerificationRepo.findOneBy({ userId: secondUserId }),
    ).toBeNull();
  });

  it('rejects verification after 5 failed NIN attempts, independently of BVN attempts', async () => {
    const userId = await seedUser();
    const token = tokenFor(userId);

    for (let i = 0; i < 5; i += 1) {
      expect((await verifyNin(token, '00000000001')).status).toBe(422);
    }

    expect((await verifyNin(token, '99988877766')).status).toBe(429);
    expect((await verifyBvn(token, '99988877766')).status).toBe(201);
    expect(
      await ctx.kycVerificationAttemptRepo.countBy({
        userId,
        identityType: 'nin',
      }),
    ).toBe(5);
  });

  it('treats resubmitting the same NIN as a free no-op and rejects a different one', async () => {
    const userId = await seedUser();
    const token = tokenFor(userId);
    await verifyNin(token, '73000000001').expect(201);
    const before = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
    const attemptsBefore = await ctx.kycVerificationAttemptRepo.countBy({
      userId,
    });

    const same = await verifyNin(token, '73000000001');
    expect(same.status).toBe(201);
    expect(same.body).toEqual({
      tier: 'tier1',
      bvnVerified: false,
      ninVerified: true,
      livenessVerified: false,
      livenessResult: 'not_requested',
    });

    const different = await verifyNin(token, '73000000002');
    expect(different.status).toBe(409);

    const after = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
    expect(after).toEqual(before);
    expect(await ctx.kycVerificationAttemptRepo.countBy({ userId })).toBe(
      attemptsBefore,
    );
    const user = await ctx.userRepo.findOneByOrFail({ id: userId });
    expect(user.kycTier).toBe('tier1');
  });

  it('does not free the old NIN for another account by overwriting it', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    await verifyNin(tokenFor(userA), '74000000001').expect(201);

    expect((await verifyNin(tokenFor(userA), '74000000002')).status).toBe(409);
    const res = await verifyNin(tokenFor(userB), '74000000001');

    expect(res.status).toBe(409);
    expect(await ctx.kycVerificationRepo.findOneBy({ userId: userB })).toBe(
      null,
    );
  });

  it('does not let a verified BVN block a first NIN', async () => {
    const userId = await seedUser();
    const token = tokenFor(userId);
    await verifyBvn(token, '75000000001').expect(201);

    const res = await verifyNin(token, '75000000002');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tier: 'tier2' });
  });
});
