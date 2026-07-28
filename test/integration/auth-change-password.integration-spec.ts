import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import {
  createAuthTestHelpers,
  extractSixDigitCode,
  SIGN_IN_CODE_SUBJECT,
} from './support/auth-test-helpers';

jest.setTimeout(120_000);

const CURRENT_PASSWORD = 'a-strong-unique-passphrase';

// Two calls, not three — the new password takes effect immediately on the
// second call, no pending/confirm step, since there's no new value that
// needs delivering and confirming first.
describe('change password', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  async function initiateStepUp(
    accessToken: string,
  ): Promise<{ challengeId: string; code: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post('/auth/change-password/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    const challengeId = (res.body as { challengeId: string }).challengeId;
    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );
    return { challengeId, code };
  }

  it('completes the full happy path: step-up then change swaps the live password', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-password-happy@example.com',
      username: 'change_password_happy',
      phone: '+2348033300001',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      CURRENT_PASSWORD,
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'a-brand-new-passphrase',
        challengeId,
        code,
        revokeOtherSessions: false,
      })
      .expect(204);

    const updated = await ctx.credentialRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(
      await bcrypt.compare('a-brand-new-passphrase', updated.passwordHash),
    ).toBe(true);
    expect(await bcrypt.compare(CURRENT_PASSWORD, updated.passwordHash)).toBe(
      false,
    );
  });

  it('rejects the wrong current password, leaving the credential unchanged', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-password-wrong-current@example.com',
      username: 'change_password_wrong_current',
      phone: '+2348033300002',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      CURRENT_PASSWORD,
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        currentPassword: 'totally-the-wrong-password',
        newPassword: 'a-brand-new-passphrase',
        challengeId,
        code,
        revokeOtherSessions: false,
      })
      .expect(401);

    const unchanged = await ctx.credentialRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(await bcrypt.compare(CURRENT_PASSWORD, unchanged.passwordHash)).toBe(
      true,
    );
  });

  it('rejects change-password without a valid step-up challenge, leaving the credential unchanged', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-password-no-stepup@example.com',
      username: 'change_password_no_stepup',
      phone: '+2348033300003',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      CURRENT_PASSWORD,
    );

    await request(ctx.app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'a-brand-new-passphrase',
        challengeId: '00000000-0000-0000-0000-000000000000',
        code: '123456',
        revokeOtherSessions: false,
      })
      .expect(404);

    const unchanged = await ctx.credentialRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(await bcrypt.compare(CURRENT_PASSWORD, unchanged.passwordHash)).toBe(
      true,
    );
  });

  it("rejects change-password using another user's step-up challenge", async () => {
    const { user: userA } = await helpers.registerUser({
      email: 'change-password-owner-a@example.com',
      username: 'change_password_owner_a',
      phone: '+2348033300004',
    });
    const { tokens: tokensA } = await helpers.loginAndVerify(
      userA.email,
      CURRENT_PASSWORD,
    );
    const { user: userB } = await helpers.registerUser({
      email: 'change-password-owner-b@example.com',
      username: 'change_password_owner_b',
      phone: '+2348033300005',
    });
    const { tokens: tokensB } = await helpers.loginAndVerify(
      userB.email,
      CURRENT_PASSWORD,
    );

    const { challengeId, code } = await initiateStepUp(tokensA.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tokensB.accessToken}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'a-brand-new-passphrase',
        challengeId,
        code,
        revokeOtherSessions: false,
      })
      .expect(410);

    const unchangedB = await ctx.credentialRepo.findOneByOrFail({
      userId: userB.id,
    });
    expect(
      await bcrypt.compare(CURRENT_PASSWORD, unchangedB.passwordHash),
    ).toBe(true);
  });

  it('rejects a new password from the common-password blocklist', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-password-weak@example.com',
      username: 'change_password_weak',
      phone: '+2348033300006',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      CURRENT_PASSWORD,
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'baseball',
        challengeId,
        code,
        revokeOtherSessions: false,
      })
      .expect(400);

    const unchanged = await ctx.credentialRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(await bcrypt.compare(CURRENT_PASSWORD, unchanged.passwordHash)).toBe(
      true,
    );
  });

  it('rejects a missing revokeOtherSessions as a validation error, rather than defaulting to false', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-password-missing-revoke@example.com',
      username: 'change_password_missing_revoke',
      phone: '+2348033300007',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      CURRENT_PASSWORD,
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'a-brand-new-passphrase',
        challengeId,
        code,
      })
      .expect(400);
  });

  it('revokeOtherSessions: true revokes every other session but leaves the confirming one active', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-password-revoke-true@example.com',
      username: 'change_password_revoke_true',
      phone: '+2348033300008',
    });
    await helpers.loginAndVerify(user.email, CURRENT_PASSWORD);
    const { tokens: secondLoginTokens } = await helpers.loginAndVerify(
      user.email,
      CURRENT_PASSWORD,
    );

    const sessionsBefore = await ctx.sessionRepo.find({
      where: { userId: user.id },
      order: { createdAt: 'ASC' },
    });
    expect(sessionsBefore.length).toBe(2);
    const otherSessionId = sessionsBefore[0].id;

    const { challengeId, code } = await initiateStepUp(
      secondLoginTokens.accessToken,
    );
    await request(ctx.app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${secondLoginTokens.accessToken}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'a-brand-new-passphrase',
        challengeId,
        code,
        revokeOtherSessions: true,
      })
      .expect(204);

    const otherSession = await ctx.sessionRepo.findOneByOrFail({
      id: otherSessionId,
    });
    expect(otherSession.status).toBe('revoked');

    const sessionsAfter = await ctx.sessionRepo.find({
      where: { userId: user.id },
    });
    const activeSessions = sessionsAfter.filter((s) => s.status === 'active');
    expect(activeSessions.length).toBe(1);
    expect(activeSessions[0].id).not.toBe(otherSessionId);
  });

  it('revokeOtherSessions: false leaves every session active', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-password-revoke-false@example.com',
      username: 'change_password_revoke_false',
      phone: '+2348033300009',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      CURRENT_PASSWORD,
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'a-brand-new-passphrase',
        challengeId,
        code,
        revokeOtherSessions: false,
      })
      .expect(204);

    const sessionsAfter = await ctx.sessionRepo.find({
      where: { userId: user.id },
    });
    expect(sessionsAfter.length).toBeGreaterThan(0);
    expect(sessionsAfter.every((s) => s.status === 'active')).toBe(true);
  });

  it('rejects an unauthenticated step-up request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/change-password/step-up')
      .send({})
      .expect(401);
  });
});
