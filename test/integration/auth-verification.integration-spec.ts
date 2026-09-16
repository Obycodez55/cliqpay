import * as request from 'supertest';
import { VerificationCodeInvalidException } from '../../src/modules/auth/internal/errors';
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

describe('email verification', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('sends a verification email on register and records an unused, expiring code', async () => {
    const { user } = await helpers.registerUser({
      email: 'verify-register@example.com',
      username: 'verify_register',
      phone: '+2348066666601',
    });

    const code = await ctx.verificationCodeRepo.findOneByOrFail({
      userId: user.id,
      purpose: 'email_verification',
    });
    expect(code.usedAt).toBeNull();
    expect(code.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const sent = await helpers.waitForVerificationEmail(user.email);
    expect(extractSixDigitCode(sent.text)).toMatch(/^\d{6}$/);
  });

  it('verifies with a valid code, sets emailVerifiedAt, and rejects reuse of the same code', async () => {
    const { user } = await helpers.registerUser({
      email: 'verify-ok@example.com',
      username: 'verify_ok',
      phone: '+2348066666602',
    });
    const sent = await helpers.waitForVerificationEmail(user.email);
    const code = extractSixDigitCode(sent.text);

    await ctx.authService.verifyEmail(code);

    const verified = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(verified.emailVerifiedAt).toBeInstanceOf(Date);

    await expect(ctx.authService.verifyEmail(code)).rejects.toBeInstanceOf(
      VerificationCodeInvalidException,
    );
  });

  it('rejects an unrecognized code without setting emailVerifiedAt', async () => {
    const { user } = await helpers.registerUser({
      email: 'verify-bad@example.com',
      username: 'verify_bad',
      phone: '+2348066666603',
    });

    await expect(
      ctx.authService.verifyEmail('never-issued-code'),
    ).rejects.toBeInstanceOf(VerificationCodeInvalidException);

    const unverified = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(unverified.emailVerifiedAt).toBeNull();
  });

  it('POST /auth/verify-email works unauthenticated, and login is not gated on it', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'verify-http@example.com',
        password: 'a-strong-unique-passphrase',
        firstName: 'Verify',
        lastName: 'Http',
        username: 'verify_http_user',
        phone: '+2348066666604',
      })
      .expect(201);

    const sent = await helpers.waitForVerificationEmail(
      'verify-http@example.com',
    );
    const code = extractSixDigitCode(sent.text);

    await request(ctx.app.getHttpServer())
      .post('/auth/verify-email')
      .send({ code })
      .expect(200);

    const verified = await ctx.userRepo.findOneByOrFail({
      email: 'verify-http@example.com',
    });
    expect(verified.emailVerifiedAt).toBeInstanceOf(Date);

    // Nothing in Phase 1 gates login on emailVerifiedAt — a full login
    // still works even before this test's own verify above ran.
    const { tokens } = await helpers.loginAndVerify(
      'verify-http@example.com',
      'a-strong-unique-passphrase',
    );
    expect(tokens.tokenType).toBe('Bearer');
  });

  it('rejects an invalid/expired code over HTTP with a clear error, distinct from a malformed request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/verify-email')
      .send({ code: 'not-a-real-code' })
      .expect(410);
  });

  it('resend is authenticated and rate-limited to 60s since the last code (including the automatic one from registration)', async () => {
    const { user } = await helpers.registerUser({
      email: 'resend@example.com',
      username: 'resend_user',
      phone: '+2348066666605',
    });

    await request(ctx.app.getHttpServer())
      .post('/auth/verify-email/resend')
      .send({})
      .expect(401);

    const { tokens } = await helpers.loginAndVerify(
      'resend@example.com',
      'a-strong-unique-passphrase',
    );

    // Wait for the fire-and-forget registration email to actually land
    // before taking the "before" count — otherwise it's a race.
    await helpers.waitForVerificationEmail('resend@example.com');

    // The registration code was just issued — an immediate resend hits
    // the 60s cooldown against that same code.
    const emailsBefore = ctx.emailAdapter.sent.length;
    await request(ctx.app.getHttpServer())
      .post('/auth/verify-email/resend')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(429);
    expect(ctx.emailAdapter.sent.length).toBe(emailsBefore);

    // Backdate that code's createdAt past the cooldown window to simulate
    // time passing, rather than sleeping the test for 60+ real seconds.
    await ctx.verificationCodeRepo.update(
      { userId: user.id, purpose: 'email_verification' },
      { createdAt: new Date(Date.now() - 61_000) },
    );

    await request(ctx.app.getHttpServer())
      .post('/auth/verify-email/resend')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(204);
    expect(ctx.emailAdapter.sent.length).toBe(emailsBefore + 1);

    // Immediate second resend hits the 60s cooldown again.
    await request(ctx.app.getHttpServer())
      .post('/auth/verify-email/resend')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(429);
    expect(ctx.emailAdapter.sent.length).toBe(emailsBefore + 1);

    // The most recently issued code (from the successful resend, not the
    // original registration send) still verifies correctly.
    const latestCode = extractSixDigitCode(ctx.emailAdapter.sent.at(-1)!.text);
    await request(ctx.app.getHttpServer())
      .post('/auth/verify-email')
      .send({ code: latestCode })
      .expect(200);
  });

  it('rejects resend for an already-verified user', async () => {
    const { user } = await helpers.registerUser({
      email: 'already-verified@example.com',
      username: 'already_verified_user',
      phone: '+2348066666606',
    });
    const sent = await helpers.waitForVerificationEmail(user.email);
    const code = extractSixDigitCode(sent.text);
    await ctx.authService.verifyEmail(code);

    const { tokens } = await helpers.loginAndVerify(
      'already-verified@example.com',
      'a-strong-unique-passphrase',
    );

    await request(ctx.app.getHttpServer())
      .post('/auth/verify-email/resend')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(409);
  });
});

describe('phone verification', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('sends a verification SMS on register and records an unused, expiring code', async () => {
    const { user } = await helpers.registerUser({
      email: 'verify-phone-register@example.com',
      username: 'verify_phone_register',
      phone: '+2348077777701',
    });

    const code = await ctx.verificationCodeRepo.findOneByOrFail({
      userId: user.id,
      purpose: 'phone_verification',
    });
    expect(code.usedAt).toBeNull();
    expect(code.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const sent = await helpers.waitForVerificationSms(user.phone);
    expect(sent.body).toMatch(/\b\d{6}\b/);
  });

  it('verifies with a valid code, sets phoneVerifiedAt, and rejects reuse of the same code', async () => {
    const { user } = await helpers.registerUser({
      email: 'verify-phone-ok@example.com',
      username: 'verify_phone_ok',
      phone: '+2348077777702',
    });
    const sent = await helpers.waitForVerificationSms(user.phone);
    const code = extractSixDigitCode(sent.body);

    await ctx.authService.verifyPhone(code);

    const verified = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(verified.phoneVerifiedAt).toBeInstanceOf(Date);

    await expect(ctx.authService.verifyPhone(code)).rejects.toBeInstanceOf(
      VerificationCodeInvalidException,
    );
  });

  it('rejects an unrecognized code without setting phoneVerifiedAt', async () => {
    const { user } = await helpers.registerUser({
      email: 'verify-phone-bad@example.com',
      username: 'verify_phone_bad',
      phone: '+2348077777703',
    });

    await expect(ctx.authService.verifyPhone('000000')).rejects.toBeInstanceOf(
      VerificationCodeInvalidException,
    );

    const unverified = await ctx.userRepo.findOneByOrFail({ id: user.id });
    expect(unverified.phoneVerifiedAt).toBeNull();
  });

  it('POST /auth/verify-phone works unauthenticated, and login is not gated on it', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'verify-phone-http@example.com',
        password: 'a-strong-unique-passphrase',
        firstName: 'Verify',
        lastName: 'Phone',
        username: 'verify_phone_http',
        phone: '+2348077777704',
      })
      .expect(201);

    const sent = await helpers.waitForVerificationSms('+2348077777704');
    const code = extractSixDigitCode(sent.body);

    await request(ctx.app.getHttpServer())
      .post('/auth/verify-phone')
      .send({ code })
      .expect(200);

    const verified = await ctx.userRepo.findOneByOrFail({
      email: 'verify-phone-http@example.com',
    });
    expect(verified.phoneVerifiedAt).toBeInstanceOf(Date);

    // Nothing in Phase 1 gates login on phoneVerifiedAt — a full login
    // still works even before this test's own verify above ran.
    const { tokens } = await helpers.loginAndVerify(
      'verify-phone-http@example.com',
      'a-strong-unique-passphrase',
    );
    expect(tokens.tokenType).toBe('Bearer');
  });

  it('rejects an invalid/expired code over HTTP with a clear error, distinct from a malformed request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/verify-phone')
      .send({ code: '000000' })
      .expect(410);
  });

  it('resend is authenticated and rate-limited to 60s since the last code (including the automatic one from registration)', async () => {
    const { user } = await helpers.registerUser({
      email: 'resend-phone@example.com',
      username: 'resend_phone_user',
      phone: '+2348077777705',
    });

    await request(ctx.app.getHttpServer())
      .post('/auth/verify-phone/resend')
      .send({})
      .expect(401);

    const { tokens } = await helpers.loginAndVerify(
      'resend-phone@example.com',
      'a-strong-unique-passphrase',
    );

    // Wait for the fire-and-forget registration SMS to actually land
    // before taking the "before" count — otherwise it's a race.
    await helpers.waitForVerificationSms(user.phone);

    // The registration code was just issued — an immediate resend hits
    // the 60s cooldown against that same code.
    const smsBefore = ctx.smsAdapter.sent.length;
    await request(ctx.app.getHttpServer())
      .post('/auth/verify-phone/resend')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(429);
    expect(ctx.smsAdapter.sent.length).toBe(smsBefore);

    // Backdate that code's createdAt past the cooldown window to simulate
    // time passing, rather than sleeping the test for 60+ real seconds.
    await ctx.verificationCodeRepo.update(
      { userId: user.id, purpose: 'phone_verification' },
      { createdAt: new Date(Date.now() - 61_000) },
    );

    await request(ctx.app.getHttpServer())
      .post('/auth/verify-phone/resend')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(204);
    expect(ctx.smsAdapter.sent.length).toBe(smsBefore + 1);

    // Immediate second resend hits the 60s cooldown again.
    await request(ctx.app.getHttpServer())
      .post('/auth/verify-phone/resend')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(429);
    expect(ctx.smsAdapter.sent.length).toBe(smsBefore + 1);

    // The most recently issued code (from the successful resend, not the
    // original registration send) still verifies correctly.
    const latestCode = extractSixDigitCode(ctx.smsAdapter.sent.at(-1)!.body);
    await request(ctx.app.getHttpServer())
      .post('/auth/verify-phone')
      .send({ code: latestCode })
      .expect(200);
  });

  it('rejects resend for an already-verified user', async () => {
    const { user } = await helpers.registerUser({
      email: 'already-phone-verified@example.com',
      username: 'already_phone_verified',
      phone: '+2348077777706',
    });
    const sent = await helpers.waitForVerificationSms(user.phone);
    const code = extractSixDigitCode(sent.body);
    await ctx.authService.verifyPhone(code);

    const { tokens } = await helpers.loginAndVerify(
      'already-phone-verified@example.com',
      'a-strong-unique-passphrase',
    );

    await request(ctx.app.getHttpServer())
      .post('/auth/verify-phone/resend')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(409);
  });
});
