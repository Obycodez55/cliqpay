import * as request from 'supertest';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import {
  createAuthTestHelpers,
  extractSixDigitCode,
  extractVerificationToken,
  SECURITY_ALERT_SUBJECT,
  SIGN_IN_CODE_SUBJECT,
  waitFor,
} from './support/auth-test-helpers';

jest.setTimeout(120_000);

// Reuses the shared helpers throughout — extractSixDigitCode for the
// step-up challenge (same MFA machinery/email template as login),
// extractVerificationToken for the new-address confirmation code (same
// 'email_verification' purpose), latestEmailWithSubject to find the
// old-address security alert.
describe('change email', () => {
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
      .post('/auth/change-email/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    const challengeId = (res.body as { challengeId: string }).challengeId;
    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );
    return { challengeId, code };
  }

  it('completes the full happy path: step-up, change, then confirm swaps the live email', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-email-happy@example.com',
      username: 'change_email_happy',
      phone: '+2348011100001',
    });
    await helpers.agePastResendCooldown(user.id, 'email_verification');
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    const alertsBefore = ctx.emailAdapter.sent.filter(
      (m) => m.subject === SECURITY_ALERT_SUBJECT,
    ).length;

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ newEmail: 'change-email-new@example.com', challengeId, code })
      .expect(204);

    // Old address gets a fire-and-forget alert, not a blocking gate.
    await waitFor(
      () =>
        ctx.emailAdapter.sent.filter(
          (m) => m.subject === SECURITY_ALERT_SUBJECT,
        ).length > alertsBefore,
    );
    const alert = helpers.latestEmailWithSubject(SECURITY_ALERT_SUBJECT);
    expect(alert.to).toBe('change-email-happy@example.com');

    // Live email hasn't changed yet — only pendingEmail is set.
    const midFlight = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(midFlight.email).toBe('change-email-happy@example.com');
    expect(midFlight.pendingEmail).toBe('change-email-new@example.com');

    const sent = await helpers.waitForVerificationEmail(
      'change-email-new@example.com',
    );
    const confirmCode = extractVerificationToken(sent.text);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: confirmCode, revokeOtherSessions: false })
      .expect(204);

    const updated = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(updated.email).toBe('change-email-new@example.com');
    expect(updated.pendingEmail).toBeNull();
    expect(updated.emailVerifiedAt).toBeInstanceOf(Date);
  });

  // Registration already issues an email_verification code fire-and-forget
  // — changeEmail must be bound by the same 60s/5-per-hour cooldown against
  // that same purpose, regardless of which address it's targeting, or it
  // becomes a way to bomb an arbitrary third-party address.
  it('rate-limits the new-address code the same way resend does, regardless of target address', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-email-rate-limit@example.com',
      username: 'change_email_rate_limit',
      phone: '+2348011100099',
    });
    await helpers.waitForVerificationEmail(user.email); // the automatic send lands
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    const sentBefore = ctx.emailAdapter.sent.length;
    await request(ctx.app.getHttpServer())
      .post('/auth/change-email')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        newEmail: 'change-email-rate-limit-target@example.com',
        challengeId,
        code,
      })
      .expect(429);
    expect(ctx.emailAdapter.sent.length).toBe(sentBefore); // no code sent

    const user2 = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(user2.pendingEmail).toBeNull(); // no state change either
  });

  it('rejects change-email without a valid step-up challenge, leaving the email unchanged', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-email-no-stepup@example.com',
      username: 'change_email_no_stepup',
      phone: '+2348011100002',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        newEmail: 'change-email-blocked@example.com',
        challengeId: '00000000-0000-0000-0000-000000000000',
        code: '123456',
      })
      .expect(404);

    const unchanged = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(unchanged.email).toBe('change-email-no-stepup@example.com');
    expect(unchanged.pendingEmail).toBeNull();
  });

  it("rejects change-email using another user's step-up challenge", async () => {
    const { user: userA } = await helpers.registerUser({
      email: 'change-email-owner-a@example.com',
      username: 'change_email_owner_a',
      phone: '+2348011100003',
    });
    const { tokens: tokensA } = await helpers.loginAndVerify(
      userA.email,
      'a-strong-unique-passphrase',
    );
    const { user: userB } = await helpers.registerUser({
      email: 'change-email-owner-b@example.com',
      username: 'change_email_owner_b',
      phone: '+2348011100004',
    });
    const { tokens: tokensB } = await helpers.loginAndVerify(
      userB.email,
      'a-strong-unique-passphrase',
    );

    const { challengeId, code } = await initiateStepUp(tokensA.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email')
      .set('Authorization', `Bearer ${tokensB.accessToken}`)
      .send({
        newEmail: 'change-email-stolen@example.com',
        challengeId,
        code,
      })
      .expect(410);

    const unchangedB = await ctx.userRepo.findOneByOrFail({ id: userB.id });
    expect(unchangedB.pendingEmail).toBeNull();
  });

  it('rejects confirm with a wrong, expired/unrecognized, or reused code, never changing the email', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-email-bad-confirm@example.com',
      username: 'change_email_bad_confirm',
      phone: '+2348011100005',
    });
    await helpers.agePastResendCooldown(user.id, 'email_verification');
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        newEmail: 'change-email-bad-confirm-new@example.com',
        challengeId,
        code,
      })
      .expect(204);

    // Unrecognized code.
    await request(ctx.app.getHttpServer())
      .post('/auth/change-email/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: 'never-issued-token', revokeOtherSessions: false })
      .expect(410);

    const stillPending = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(stillPending.email).toBe('change-email-bad-confirm@example.com');
    expect(stillPending.pendingEmail).toBe(
      'change-email-bad-confirm-new@example.com',
    );

    const sent = await helpers.waitForVerificationEmail(
      'change-email-bad-confirm-new@example.com',
    );
    const confirmCode = extractVerificationToken(sent.text);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: confirmCode, revokeOtherSessions: false })
      .expect(204);

    // Reusing the same (now-consumed) code fails and doesn't touch the
    // already-confirmed email again.
    await request(ctx.app.getHttpServer())
      .post('/auth/change-email/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: confirmCode, revokeOtherSessions: false })
      .expect(410);

    const finalUser = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(finalUser.email).toBe('change-email-bad-confirm-new@example.com');
  });

  it('rejects a missing revokeOtherSessions as a validation error, rather than defaulting to false', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-email-missing-revoke@example.com',
      username: 'change_email_missing_revoke',
      phone: '+2348011100006',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: 'irrelevant-code' })
      .expect(400);
  });

  it('revokeOtherSessions: true revokes every other session but leaves the confirming one active', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-email-revoke-true@example.com',
      username: 'change_email_revoke_true',
      phone: '+2348011100007',
    });
    await helpers.agePastResendCooldown(user.id, 'email_verification');
    await helpers.loginAndVerify(user.email, 'a-strong-unique-passphrase');
    const { tokens: secondLoginTokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
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
      .post('/auth/change-email')
      .set('Authorization', `Bearer ${secondLoginTokens.accessToken}`)
      .send({
        newEmail: 'change-email-revoke-true-new@example.com',
        challengeId,
        code,
      })
      .expect(204);

    const sent = await helpers.waitForVerificationEmail(
      'change-email-revoke-true-new@example.com',
    );
    const confirmCode = extractVerificationToken(sent.text);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email/confirm')
      .set('Authorization', `Bearer ${secondLoginTokens.accessToken}`)
      .send({ code: confirmCode, revokeOtherSessions: true })
      .expect(204);

    const otherSession = await ctx.sessionRepo.findOneByOrFail({
      id: otherSessionId,
    });
    expect(otherSession.status).toBe('revoked');

    // The confirming call's own session (from secondLoginTokens) survives.
    const sessionsAfter = await ctx.sessionRepo.find({
      where: { userId: user.id },
    });
    const activeSessions = sessionsAfter.filter((s) => s.status === 'active');
    expect(activeSessions.length).toBe(1);
    expect(activeSessions[0].id).not.toBe(otherSessionId);
  });

  it('revokeOtherSessions: false leaves every session active', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-email-revoke-false@example.com',
      username: 'change_email_revoke_false',
      phone: '+2348011100008',
    });
    await helpers.agePastResendCooldown(user.id, 'email_verification');
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        newEmail: 'change-email-revoke-false-new@example.com',
        challengeId,
        code,
      })
      .expect(204);

    const sent = await helpers.waitForVerificationEmail(
      'change-email-revoke-false-new@example.com',
    );
    const confirmCode = extractVerificationToken(sent.text);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-email/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: confirmCode, revokeOtherSessions: false })
      .expect(204);

    const sessionsAfter = await ctx.sessionRepo.find({
      where: { userId: user.id },
    });
    expect(sessionsAfter.length).toBeGreaterThan(0);
    expect(sessionsAfter.every((s) => s.status === 'active')).toBe(true);
  });

  it('rejects an unauthenticated step-up request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/change-email/step-up')
      .send({})
      .expect(401);
  });
});
