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

// FakeKycProvider: the same fake person comes back from a BVN and a NIN by
// default; the 5th digit "9" is a different person, "8" the same name with a
// different date of birth.
const SAME = '0';
const OTHER_PERSON = '9';
const OTHER_DOB = '8';
const JPEG = '/9j/AAAA';

describe('BVN and NIN must belong to the same person', () => {
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
      email: `sameperson-${n}@example.com`,
      phone: `+2348088${String(500_000 + n).padStart(6, '0')}`,
      username: `sameperson_user_${n}`,
    });
    return { userId, token: jwtService.sign({ sub: userId, sid: 's' }) };
  }

  function id(fifthDigit: string): string {
    idSeq += 1;
    return `7777${fifthDigit}${String(idSeq).padStart(6, '0')}`;
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

  function capture() {
    return {
      selfieImage: JPEG,
      livenessImages: Array<string>(6).fill(JPEG),
      consentGranted: true,
    };
  }

  async function userTier(userId: string) {
    return (await ctx.userRepo.findOneByOrFail({ id: userId })).kycTier;
  }

  it('rejects a NIN of a different person than the verified BVN, persisting nothing and counting a failed attempt', async () => {
    const { userId, token } = await seedUser();
    await verify(token, 'bvn', id(SAME)).expect(201);

    const res = await verify(token, 'nin', id(OTHER_PERSON));

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain(
      "This NIN doesn't match the BVN already verified on your account.",
    );
    const record = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
    expect(record.ninHash).toBeNull();
    expect(record.identity?.nin).toBeUndefined();
    expect(await userTier(userId)).toBe('tier1');
    const nin = await ctx.kycVerificationAttemptRepo.findBy({
      userId,
      identityType: 'nin',
    });
    expect(nin.map((a) => a.succeeded)).toEqual([false]);
  });

  it('rejects a BVN of a different person than the verified NIN', async () => {
    const { userId, token } = await seedUser();
    await verify(token, 'nin', id(SAME)).expect(201);

    const res = await verify(token, 'bvn', id(OTHER_PERSON));

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain(
      "This BVN doesn't match the NIN already verified on your account.",
    );
    expect(await userTier(userId)).toBe('tier1');
  });

  it.each([
    ['BVN then NIN', 'bvn', 'nin'],
    ['NIN then BVN', 'nin', 'bvn'],
  ] as const)(
    'reaches tier2 when the %s match',
    async (_label, first, second) => {
      const { userId, token } = await seedUser();

      await verify(token, first, id(SAME)).expect(201);
      const res = await verify(token, second, id(SAME));

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ tier: 'tier2' });
      expect(await userTier(userId)).toBe('tier2');
      const record = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
      expect(record.verifiedLegalName).toBe('Ada Obi Lovelace');
      expect(Object.keys(record.identity ?? {}).sort()).toEqual(['bvn', 'nin']);
    },
  );

  it('rejects matching names with a different date of birth', async () => {
    const { token } = await seedUser();
    await verify(token, 'bvn', id(SAME)).expect(201);

    const res = await verify(token, 'nin', id(OTHER_DOB));

    expect(res.status).toBe(422);
  });

  it('counts every mismatch toward the 5-per-24h limit for that identifier type', async () => {
    const { token } = await seedUser();
    await verify(token, 'bvn', id(SAME)).expect(201);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await verify(token, 'nin', id(OTHER_PERSON))).status);
    }

    expect(statuses).toEqual([422, 422, 422, 422, 422, 429]);
  });

  it('keeps liveness passed when a matching second identifier is verified afterwards', async () => {
    const { userId, token } = await seedUser();
    await verify(token, 'bvn', id(SAME), capture()).expect(201);

    const res = await verify(token, 'nin', id(SAME), capture());

    expect(res.body).toMatchObject({
      tier: 'tier3',
      livenessVerified: true,
      livenessResult: 'passed',
    });
    expect(await userTier(userId)).toBe('tier3');
  });

  it('does not let an unrelated NIN ride on liveness passed on the BVN', async () => {
    const { userId, token } = await seedUser();
    await verify(token, 'bvn', id(SAME), capture()).expect(201);

    const res = await verify(token, 'nin', id(OTHER_PERSON), capture());

    expect(res.status).toBe(422);
    expect(await userTier(userId)).toBe('tier1');
  });

  it('lets exactly one of a concurrent BVN and a mismatching NIN succeed', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { userId, token } = await seedUser();

      const [bvn, nin] = await Promise.all([
        verify(token, 'bvn', id(SAME)),
        verify(token, 'nin', id(OTHER_PERSON)),
      ]);

      expect([bvn.status, nin.status].sort()).toEqual([201, 422]);
      const record = await ctx.kycVerificationRepo.findOneByOrFail({ userId });
      expect(!!record.bvnHash !== !!record.ninHash).toBe(true);
      expect(await userTier(userId)).toBe('tier1');
    }
  });
});
