import * as request from 'supertest';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
} from './support/withdrawals-test-context';
import {
  createAuthTestHelpers,
  extractSixDigitCode,
  SIGN_IN_CODE_SUBJECT,
} from './support/auth-test-helpers';

jest.setTimeout(120_000);

describe('withdrawals bank accounts', () => {
  let ctx: WithdrawalsTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  async function initiateStepUp(
    accessToken: string,
  ): Promise<{ challengeId: string; code: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    const challengeId = (res.body as { challengeId: string }).challengeId;
    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );
    return { challengeId, code };
  }

  async function registerAndLogin(overrides: Record<string, unknown>) {
    const { user } = await helpers.registerUser(overrides);
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    return { user, tokens };
  }

  it('saves a bank account using the provider-resolved name, not any client-supplied one', async () => {
    const { user, tokens } = await registerAndLogin({
      email: 'save-bank-happy@example.com',
      username: 'save_bank_happy',
      phone: '+2348033400001',
    });
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    const res = await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        bankCode: '033',
        accountNumber: '0000000000',
        challengeId,
        code,
      })
      .expect(201);

    expect(res.body).toMatchObject({
      bankCode: '033',
      bankName: 'Test Bank 033',
      accountNumber: '0000000000',
      accountName: 'Test Account 0000000000',
    });

    const saved = await ctx.bankAccountRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(saved.accountName).toBe('Test Account 0000000000');
    expect(saved.provider).toBe('kora');
  });

  it('rejects saving without a valid step-up challenge, persisting nothing', async () => {
    const { user, tokens } = await registerAndLogin({
      email: 'save-bank-no-stepup@example.com',
      username: 'save_bank_no_stepup',
      phone: '+2348033400002',
    });

    await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        bankCode: '033',
        accountNumber: '0000000001',
        challengeId: '00000000-0000-0000-0000-000000000000',
        code: '123456',
      })
      .expect(404);

    const saved = await ctx.bankAccountRepo.find({
      where: { userId: user.id },
    });
    expect(saved).toEqual([]);
  });

  it("rejects saving using another user's step-up challenge", async () => {
    const { tokens: tokensA } = await registerAndLogin({
      email: 'save-bank-owner-a@example.com',
      username: 'save_bank_owner_a',
      phone: '+2348033400003',
    });
    const { user: userB, tokens: tokensB } = await registerAndLogin({
      email: 'save-bank-owner-b@example.com',
      username: 'save_bank_owner_b',
      phone: '+2348033400004',
    });

    const { challengeId, code } = await initiateStepUp(tokensA.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokensB.accessToken}`)
      .send({
        bankCode: '033',
        accountNumber: '0000000002',
        challengeId,
        code,
      })
      .expect(410);

    const saved = await ctx.bankAccountRepo.find({
      where: { userId: userB.id },
    });
    expect(saved).toEqual([]);
  });

  it('persists nothing when the provider cannot resolve the account', async () => {
    const { user, tokens } = await registerAndLogin({
      email: 'save-bank-not-resolvable@example.com',
      username: 'save_bank_not_resolvable',
      phone: '+2348033400005',
    });
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);
    // NUBAN-shaped so it clears the DTO's digit-only validation — the
    // fake adapter's "fail" sentinel isn't usable here since it isn't
    // numeric, so the not_found outcome is configured directly instead.
    ctx.fakeAdapter.setResolveBankAccountResult('033', '0000000009', {
      status: 'not_found',
    });

    await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        bankCode: '033',
        accountNumber: '0000000009',
        challengeId,
        code,
      })
      .expect(422);

    const saved = await ctx.bankAccountRepo.find({
      where: { userId: user.id },
    });
    expect(saved).toEqual([]);
  });

  it('rejects saving the same bank account twice for the same user', async () => {
    const { tokens } = await registerAndLogin({
      email: 'save-bank-duplicate@example.com',
      username: 'save_bank_duplicate',
      phone: '+2348033400006',
    });

    const first = await initiateStepUp(tokens.accessToken);
    await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        bankCode: '033',
        accountNumber: '0000000003',
        challengeId: first.challengeId,
        code: first.code,
      })
      .expect(201);

    const second = await initiateStepUp(tokens.accessToken);
    await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        bankCode: '033',
        accountNumber: '0000000003',
        challengeId: second.challengeId,
        code: second.code,
      })
      .expect(409);
  });

  it('allows saving multiple different bank accounts for the same user, with no default flag', async () => {
    const { user, tokens } = await registerAndLogin({
      email: 'save-bank-multiple@example.com',
      username: 'save_bank_multiple',
      phone: '+2348033400007',
    });

    const first = await initiateStepUp(tokens.accessToken);
    await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        bankCode: '033',
        accountNumber: '0000000004',
        challengeId: first.challengeId,
        code: first.code,
      })
      .expect(201);

    const second = await initiateStepUp(tokens.accessToken);
    await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        bankCode: '058',
        accountNumber: '0000000005',
        challengeId: second.challengeId,
        code: second.code,
      })
      .expect(201);

    const res = await request(ctx.app.getHttpServer())
      .get('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(
      (res.body as { bankCode: string }[]).map((b) => b.bankCode).sort(),
    ).toEqual(['033', '058']);
    expect((res.body as { accountName?: string }[])[0]).not.toHaveProperty(
      'default',
    );

    const saved = await ctx.bankAccountRepo.find({
      where: { userId: user.id },
    });
    expect(saved).toHaveLength(2);
  });

  it("never returns another user's bank accounts", async () => {
    const { tokens: tokensA } = await registerAndLogin({
      email: 'save-bank-list-owner-a@example.com',
      username: 'save_bank_list_owner_a',
      phone: '+2348033400008',
    });
    const { tokens: tokensB } = await registerAndLogin({
      email: 'save-bank-list-owner-b@example.com',
      username: 'save_bank_list_owner_b',
      phone: '+2348033400009',
    });

    const stepUp = await initiateStepUp(tokensA.accessToken);
    await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokensA.accessToken}`)
      .send({
        bankCode: '033',
        accountNumber: '0000000006',
        challengeId: stepUp.challengeId,
        code: stepUp.code,
      })
      .expect(201);

    const res = await request(ctx.app.getHttpServer())
      .get('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${tokensB.accessToken}`)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('rejects an unauthenticated step-up request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts/step-up')
      .send({})
      .expect(401);
  });

  it('rejects an unauthenticated list request', async () => {
    await request(ctx.app.getHttpServer())
      .get('/withdrawals/bank-accounts')
      .expect(401);
  });
});
