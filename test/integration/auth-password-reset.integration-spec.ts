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
} from './support/auth-test-helpers';

jest.setTimeout(120_000);

describe('password reset', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('POST /auth/password-reset/request returns 200 whether or not the email exists, only emailing a real account', async () => {
    const { user } = await helpers.registerUser({
      email: 'reset-request@example.com',
      username: 'reset_request_user',
      phone: '+2348088888801',
    });

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email: user.email })
      .expect(200);
    const sent = await helpers.waitForPasswordResetEmail(user.email);
    expect(extractSixDigitCode(sent.text)).toMatch(/^\d{6}$/);

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email: 'no-such-reset-user@example.com' })
      .expect(200);
    expect(
      ctx.emailAdapter.sent.some(
        (m) => m.to === 'no-such-reset-user@example.com',
      ),
    ).toBe(false);
  });

  it('rate-limits repeated requests for the same account without changing the response (no enumeration signal)', async () => {
    const { user } = await helpers.registerUser({
      email: 'reset-rate-limit@example.com',
      username: 'reset_rate_limit_user',
      phone: '+2348088888804',
    });

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email: user.email })
      .expect(200);
    await helpers.waitForPasswordResetEmail(user.email);

    // Immediately repeating the request hits the 60s cooldown — but the
    // response stays 200 either way (see AuthService.requestPasswordReset),
    // it just doesn't send a second email.
    const emailsBefore = ctx.emailAdapter.sent.length;
    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email: user.email })
      .expect(200);
    expect(ctx.emailAdapter.sent.length).toBe(emailsBefore);
  });

  it('completes a reset with a valid code: new password works, old one does not, and the code is single-use', async () => {
    const { user } = await helpers.registerUser({
      email: 'reset-complete@example.com',
      username: 'reset_complete_user',
      phone: '+2348088888802',
    });

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email: user.email })
      .expect(200);
    const sent = await helpers.waitForPasswordResetEmail(user.email);
    const code = extractSixDigitCode(sent.text);

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({
        code,
        newPassword: 'a-brand-new-passphrase',
        revokeOtherSessions: false,
      })
      .expect(200);

    const updated = await ctx.credentialRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(
      await bcrypt.compare('a-brand-new-passphrase', updated.passwordHash),
    ).toBe(true);
    expect(
      await bcrypt.compare('a-strong-unique-passphrase', updated.passwordHash),
    ).toBe(false);

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({
        code,
        newPassword: 'yet-another-passphrase',
        revokeOtherSessions: false,
      })
      .expect(410);
  });

  it('rejects an unrecognized code over HTTP with a clear error, distinct from a malformed request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({
        code: 'never-issued-code',
        newPassword: 'a-brand-new-passphrase',
        revokeOtherSessions: false,
      })
      .expect(410);
  });

  it('rejects a missing revokeOtherSessions as a validation error, rather than defaulting to false', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({
        code: 'irrelevant-code',
        newPassword: 'a-brand-new-passphrase',
      })
      .expect(400);
  });

  it('revokeOtherSessions: true revokes every session for the user', async () => {
    const { user } = await helpers.registerUser({
      email: 'reset-revoke-true@example.com',
      username: 'reset_revoke_true_user',
      phone: '+2348088888805',
    });
    await helpers.loginAndVerify(user.email, 'a-strong-unique-passphrase');
    const sessionsBefore = await ctx.sessionRepo.find({
      where: { userId: user.id },
    });
    expect(sessionsBefore.length).toBeGreaterThan(0);
    expect(sessionsBefore.every((s) => s.status === 'active')).toBe(true);

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email: user.email })
      .expect(200);
    const sent = await helpers.waitForPasswordResetEmail(user.email);
    const code = extractSixDigitCode(sent.text);

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({
        code,
        newPassword: 'a-brand-new-passphrase',
        revokeOtherSessions: true,
      })
      .expect(200);

    const sessionsAfter = await ctx.sessionRepo.find({
      where: { userId: user.id },
    });
    expect(sessionsAfter.length).toBeGreaterThan(0);
    expect(sessionsAfter.every((s) => s.status === 'revoked')).toBe(true);
  });

  it('revokeOtherSessions: false leaves existing sessions active', async () => {
    const { user } = await helpers.registerUser({
      email: 'reset-revoke-false@example.com',
      username: 'reset_revoke_false_user',
      phone: '+2348088888806',
    });
    await helpers.loginAndVerify(user.email, 'a-strong-unique-passphrase');

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email: user.email })
      .expect(200);
    const sent = await helpers.waitForPasswordResetEmail(user.email);
    const code = extractSixDigitCode(sent.text);

    await request(ctx.app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({
        code,
        newPassword: 'a-brand-new-passphrase',
        revokeOtherSessions: false,
      })
      .expect(200);

    const sessionsAfter = await ctx.sessionRepo.find({
      where: { userId: user.id },
    });
    expect(sessionsAfter.length).toBeGreaterThan(0);
    expect(sessionsAfter.every((s) => s.status === 'active')).toBe(true);
  });
});
