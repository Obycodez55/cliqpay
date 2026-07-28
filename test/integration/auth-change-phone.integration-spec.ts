import * as request from 'supertest';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import {
  createAuthTestHelpers,
  extractSixDigitCode,
  SECURITY_ALERT_SUBJECT,
  SIGN_IN_CODE_SUBJECT,
  waitFor,
} from './support/auth-test-helpers';

jest.setTimeout(120_000);

// Mirrors the "change email" flow (same shape). Reuses extractSixDigitCode
// for both the step-up challenge (from the sign-in-code email) and the
// new-number confirmation code (from the SMS body — phone verification is
// numeric-format, unlike email's opaque link token), and
// latestEmailWithSubject to find the security alert, which — per
// changePhone()'s own reasoning — still goes to the account's email, since
// there's no SMS-based alert channel.
describe('change phone', () => {
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
      .post('/auth/change-phone/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    const challengeId = (res.body as { challengeId: string }).challengeId;
    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );
    return { challengeId, code };
  }

  it('completes the full happy path: step-up, change, then confirm swaps the live phone', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-phone-happy@example.com',
      username: 'change_phone_happy',
      phone: '+2348022200001',
    });
    await helpers.agePastResendCooldown(user.id, 'phone_verification');
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    const alertsBefore = ctx.emailAdapter.sent.filter(
      (m) => m.subject === SECURITY_ALERT_SUBJECT,
    ).length;

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ newPhone: '+2348022200099', challengeId, code })
      .expect(204);

    // The alert goes to the account's email, not SMS — fire-and-forget,
    // not a blocking gate.
    await waitFor(
      () =>
        ctx.emailAdapter.sent.filter(
          (m) => m.subject === SECURITY_ALERT_SUBJECT,
        ).length > alertsBefore,
    );
    const alert = helpers.latestEmailWithSubject(SECURITY_ALERT_SUBJECT);
    expect(alert.to).toBe('change-phone-happy@example.com');

    // Live phone hasn't changed yet — only pendingPhone is set.
    const midFlight = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(midFlight.phone).toBe('+2348022200001');
    expect(midFlight.pendingPhone).toBe('+2348022200099');

    const sent = await helpers.waitForVerificationSms('+2348022200099');
    const confirmCode = extractSixDigitCode(sent.body);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: confirmCode, revokeOtherSessions: false })
      .expect(204);

    const updated = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(updated.phone).toBe('+2348022200099');
    expect(updated.pendingPhone).toBeNull();
    expect(updated.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  // Same reasoning as change-email's rate-limit test — registration
  // already issues a phone_verification code fire-and-forget, and SMS
  // costs real money per send, so this closes a real cost-abuse vector
  // against an arbitrary third-party number.
  it('rate-limits the new-number code the same way resend does, regardless of target number', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-phone-rate-limit@example.com',
      username: 'change_phone_rate_limit',
      phone: '+2348022200097',
    });
    await helpers.waitForVerificationSms(user.phone); // the automatic send lands
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    const smsSentBefore = ctx.smsAdapter.sent.length;
    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ newPhone: '+2348022200096', challengeId, code })
      .expect(429);
    expect(ctx.smsAdapter.sent.length).toBe(smsSentBefore); // no code sent

    const user2 = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(user2.pendingPhone).toBeNull(); // no state change either
  });

  it('rejects change-phone without a valid step-up challenge, leaving the phone unchanged', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-phone-no-stepup@example.com',
      username: 'change_phone_no_stepup',
      phone: '+2348022200002',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        newPhone: '+2348022200098',
        challengeId: '00000000-0000-0000-0000-000000000000',
        code: '123456',
      })
      .expect(404);

    const unchanged = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(unchanged.phone).toBe('+2348022200002');
    expect(unchanged.pendingPhone).toBeNull();
  });

  it("rejects change-phone using another user's step-up challenge", async () => {
    const { user: userA } = await helpers.registerUser({
      email: 'change-phone-owner-a@example.com',
      username: 'change_phone_owner_a',
      phone: '+2348022200003',
    });
    const { tokens: tokensA } = await helpers.loginAndVerify(
      userA.email,
      'a-strong-unique-passphrase',
    );
    const { user: userB } = await helpers.registerUser({
      email: 'change-phone-owner-b@example.com',
      username: 'change_phone_owner_b',
      phone: '+2348022200004',
    });
    const { tokens: tokensB } = await helpers.loginAndVerify(
      userB.email,
      'a-strong-unique-passphrase',
    );

    const { challengeId, code } = await initiateStepUp(tokensA.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone')
      .set('Authorization', `Bearer ${tokensB.accessToken}`)
      .send({
        newPhone: '+2348022200097',
        challengeId,
        code,
      })
      .expect(410);

    const unchangedB = await ctx.userRepo.findOneByOrFail({ id: userB.id });
    expect(unchangedB.pendingPhone).toBeNull();
  });

  it('rejects confirm with a wrong, expired/unrecognized, or reused code, never changing the phone', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-phone-bad-confirm@example.com',
      username: 'change_phone_bad_confirm',
      phone: '+2348022200005',
    });
    await helpers.agePastResendCooldown(user.id, 'phone_verification');
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        newPhone: '+2348022200096',
        challengeId,
        code,
      })
      .expect(204);

    // Unrecognized code.
    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: '000000', revokeOtherSessions: false })
      .expect(410);

    const stillPending = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(stillPending.phone).toBe('+2348022200005');
    expect(stillPending.pendingPhone).toBe('+2348022200096');

    const sent = await helpers.waitForVerificationSms('+2348022200096');
    const confirmCode = extractSixDigitCode(sent.body);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: confirmCode, revokeOtherSessions: false })
      .expect(204);

    // Reusing the same (now-consumed) code fails and doesn't touch the
    // already-confirmed phone again.
    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: confirmCode, revokeOtherSessions: false })
      .expect(410);

    const finalUser = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(finalUser.phone).toBe('+2348022200096');
  });

  it('rejects a missing revokeOtherSessions as a validation error, rather than defaulting to false', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-phone-missing-revoke@example.com',
      username: 'change_phone_missing_revoke',
      phone: '+2348022200006',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone/confirm')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ code: 'irrelevant-code' })
      .expect(400);
  });

  it('revokeOtherSessions: true revokes every other session but leaves the confirming one active', async () => {
    const { user } = await helpers.registerUser({
      email: 'change-phone-revoke-true@example.com',
      username: 'change_phone_revoke_true',
      phone: '+2348022200007',
    });
    await helpers.agePastResendCooldown(user.id, 'phone_verification');
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
      .post('/auth/change-phone')
      .set('Authorization', `Bearer ${secondLoginTokens.accessToken}`)
      .send({
        newPhone: '+2348022200095',
        challengeId,
        code,
      })
      .expect(204);

    const sent = await helpers.waitForVerificationSms('+2348022200095');
    const confirmCode = extractSixDigitCode(sent.body);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone/confirm')
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
      email: 'change-phone-revoke-false@example.com',
      username: 'change_phone_revoke_false',
      phone: '+2348022200008',
    });
    await helpers.agePastResendCooldown(user.id, 'phone_verification');
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    const { challengeId, code } = await initiateStepUp(tokens.accessToken);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        newPhone: '+2348022200094',
        challengeId,
        code,
      })
      .expect(204);

    const sent = await helpers.waitForVerificationSms('+2348022200094');
    const confirmCode = extractSixDigitCode(sent.body);

    await request(ctx.app.getHttpServer())
      .post('/auth/change-phone/confirm')
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
      .post('/auth/change-phone/step-up')
      .send({})
      .expect(401);
  });
});
