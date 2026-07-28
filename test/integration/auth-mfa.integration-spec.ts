import { generate as generateTotpCode } from 'otplib';
import * as request from 'supertest';
import { EnrollTotpResponseDto } from '../../src/modules/auth/dto/enroll-totp-response.dto';
import { LoginResponseDto } from '../../src/modules/auth/dto/login-response.dto';
import {
  InvalidMfaCodeException,
  MfaChallengeInvalidException,
  MfaChallengeNotFoundException,
} from '../../src/modules/auth/internal/errors';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import {
  createAuthTestHelpers,
  extractSixDigitCode,
  SIGN_IN_CODE_SUBJECT,
  TEST_DEVICE,
  wrongCodeFor,
} from './support/auth-test-helpers';

jest.setTimeout(120_000);

describe('MFA enrollment, challenges, and trusted devices', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('TOTP enroll-then-confirm activates the method, staying pending until a correct code is submitted', async () => {
    const { user } = await helpers.registerUser({
      email: 'totp@example.com',
      username: 'totp_user',
      phone: '+2348055555501',
    });

    const { secret, otpauthUrl } = await ctx.mfaService.enrollTotp(user.id);
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(otpauthUrl).toContain(encodeURIComponent(user.email));

    const pending = await ctx.mfaMethodRepo.findOneByOrFail({
      userId: user.id,
      type: 'totp',
    });
    expect(pending.status).toBe('pending');
    expect(pending.secretCiphertext).not.toBeNull();
    expect(pending.secretCiphertext).not.toBe(secret); // encrypted at rest

    const correctCode = await generateTotpCode({ secret });
    await expect(
      ctx.mfaService.confirmTotp(user.id, wrongCodeFor(correctCode)),
    ).rejects.toBeInstanceOf(InvalidMfaCodeException);
    expect(
      (
        await ctx.mfaMethodRepo.findOneByOrFail({
          userId: user.id,
          type: 'totp',
        })
      ).status,
    ).toBe('pending');

    await ctx.mfaService.confirmTotp(user.id, correctCode);
    expect(
      (
        await ctx.mfaMethodRepo.findOneByOrFail({
          userId: user.id,
          type: 'totp',
        })
      ).status,
    ).toBe('active');
  });

  it('login on an untrusted device creates a challenge; the wrong code is rejected and the right one succeeds', async () => {
    await helpers.registerUser({
      email: 'untrusted@example.com',
      username: 'untrusted_user',
      phone: '+2348055555502',
    });

    const result = await ctx.authService.login(
      {
        email: 'untrusted@example.com',
        password: 'a-strong-unique-passphrase',
      },
      null,
      TEST_DEVICE,
    );
    expect(result.mfaRequired).toBe(true);
    if (!result.mfaRequired) {
      throw new Error('expected a challenge');
    }
    expect(result.method).toBe('email');

    const correctCode = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );

    await expect(
      ctx.authService.verifyMfaChallenge(
        { challengeId: result.challengeId, code: wrongCodeFor(correctCode) },
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(InvalidMfaCodeException);

    const { tokens, trustedDeviceToken } =
      await ctx.authService.verifyMfaChallenge(
        { challengeId: result.challengeId, code: correctCode },
        TEST_DEVICE,
      );
    expect(tokens.tokenType).toBe('Bearer');
    expect(typeof trustedDeviceToken).toBe('string');
  });

  it('login from a device with a valid trusted-device cookie skips the MFA challenge', async () => {
    const { user } = await helpers.registerUser({
      email: 'trusted@example.com',
      username: 'trusted_user',
      phone: '+2348055555503',
    });
    const { trustedDeviceToken } = await helpers.loginAndVerify(
      'trusted@example.com',
      'a-strong-unique-passphrase',
    );

    const emailsBefore = ctx.emailAdapter.sent.length;
    const result = await ctx.authService.login(
      {
        email: 'trusted@example.com',
        password: 'a-strong-unique-passphrase',
      },
      trustedDeviceToken,
      TEST_DEVICE,
    );

    expect(result.mfaRequired).toBe(false);
    expect(ctx.emailAdapter.sent.length).toBe(emailsBefore); // no new challenge sent
    if (result.mfaRequired) {
      throw new Error('expected the challenge to be skipped');
    }

    const sessions = await ctx.sessionRepo.find({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
    });
    expect(sessions[0].trustedDeviceId).not.toBeNull();
  });

  it('invalidates an MFA challenge after 5 wrong attempts, requiring a new one even with the right code', async () => {
    await helpers.registerUser({
      email: 'five-attempts@example.com',
      username: 'five_attempts_user',
      phone: '+2348055555504',
    });

    const result = await ctx.authService.login(
      {
        email: 'five-attempts@example.com',
        password: 'a-strong-unique-passphrase',
      },
      null,
      TEST_DEVICE,
    );
    if (!result.mfaRequired) {
      throw new Error('expected a challenge');
    }
    const correctCode = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );
    const wrong = wrongCodeFor(correctCode);

    for (let i = 0; i < 5; i++) {
      await expect(
        ctx.authService.verifyMfaChallenge(
          { challengeId: result.challengeId, code: wrong },
          TEST_DEVICE,
        ),
      ).rejects.toBeInstanceOf(InvalidMfaCodeException);
    }

    const challenge = await ctx.mfaChallengeRepo.findOneByOrFail({
      id: result.challengeId,
    });
    expect(challenge.status).toBe('failed');
    expect(challenge.attempts).toBe(5);

    // Even the correct code no longer works — a new challenge is required.
    await expect(
      ctx.authService.verifyMfaChallenge(
        { challengeId: result.challengeId, code: correctCode },
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(MfaChallengeInvalidException);
  });

  it('rejects verification against a nonexistent challenge', async () => {
    await expect(
      ctx.authService.verifyMfaChallenge(
        {
          challengeId: '00000000-0000-0000-0000-000000000000',
          code: '123456',
        },
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(MfaChallengeNotFoundException);
  });
});

describe('MFA over HTTP — trusted-device cookie and the JWT guard', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('sets an httpOnly trusted-device cookie on verify, and presenting it skips the next challenge', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'http-cookie@example.com',
        password: 'a-strong-unique-passphrase',
        firstName: 'Cookie',
        lastName: 'Monster',
        username: 'http_cookie_user',
        phone: '+2348055555599',
      })
      .expect(201);

    const loginRes = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .set('User-Agent', 'Cliqpay-Test-Client/1.0')
      .send({
        email: 'http-cookie@example.com',
        password: 'a-strong-unique-passphrase',
      })
      .expect(200);
    const loginBody = loginRes.body as LoginResponseDto;
    expect(loginBody.mfaRequired).toBe(true);
    if (!loginBody.mfaRequired) {
      throw new Error('expected a challenge');
    }
    const { challengeId } = loginBody;

    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );

    const verifyRes = await request(ctx.app.getHttpServer())
      .post('/mfa/verify')
      .set('User-Agent', 'Cliqpay-Test-Client/1.0')
      .send({ challengeId, code })
      .expect(200);

    const setCookieHeader = verifyRes.headers['set-cookie'] as unknown as
      | string[]
      | string;
    const cookies = ([] as string[]).concat(setCookieHeader);
    const trustedDeviceCookie = cookies.find((c) =>
      c.startsWith('cliqpay_trusted_device='),
    );
    expect(trustedDeviceCookie).toBeDefined();
    expect(trustedDeviceCookie).toContain('HttpOnly');
    expect(trustedDeviceCookie).toMatch(/SameSite=Lax/i);

    // Real request metadata, not the test-only TEST_DEVICE constant —
    // proves the controller actually reads req.ip/User-Agent rather than
    // relying on a fixed value.
    const httpCookieUser = await ctx.userRepo.findOneByOrFail({
      email: 'http-cookie@example.com',
    });
    const httpCookieDevice = await ctx.trustedDeviceRepo.findOneByOrFail({
      userId: httpCookieUser.id,
    });
    expect(httpCookieDevice.device.userAgent).toBe('Cliqpay-Test-Client/1.0');
    expect(httpCookieDevice.device.ipAddress).toEqual(expect.any(String));
    expect(httpCookieDevice.device.ipAddress.length).toBeGreaterThan(0);

    const cookieValue = trustedDeviceCookie!.split(';')[0];

    const secondLoginRes = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .set('Cookie', cookieValue)
      .send({
        email: 'http-cookie@example.com',
        password: 'a-strong-unique-passphrase',
      })
      .expect(200);
    const secondLoginBody = secondLoginRes.body as LoginResponseDto;
    expect(secondLoginBody.mfaRequired).toBe(false);
    if (secondLoginBody.mfaRequired) {
      throw new Error('expected the challenge to be skipped');
    }
    expect(secondLoginBody.tokenType).toBe('Bearer');
  });

  it('rejects an unauthenticated TOTP enroll request', async () => {
    await request(ctx.app.getHttpServer())
      .post('/mfa/totp/enroll')
      .send({})
      .expect(401);
  });

  // Step-up gating on TOTP enroll — without it, a bearer token alone could
  // silently plant a persistent TOTP backdoor.
  async function initiateTotpEnrollStepUp(
    accessToken: string,
  ): Promise<{ challengeId: string; code: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post('/mfa/totp/enroll/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    const challengeId = (res.body as { challengeId: string }).challengeId;
    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );
    return { challengeId, code };
  }

  it('accepts a TOTP enroll request completed with a valid step-up challenge', async () => {
    const { user } = await helpers.registerUser({
      email: 'totp-enroll-stepup@example.com',
      username: 'totp_enroll_stepup',
      phone: '+2348055555590',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    const { challengeId, code } = await initiateTotpEnrollStepUp(
      tokens.accessToken,
    );

    const res = await request(ctx.app.getHttpServer())
      .post('/mfa/totp/enroll')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ challengeId, code })
      .expect(200);

    const body = res.body as EnrollTotpResponseDto;
    expect(body.secret).toBeDefined();
    expect(body.otpauthUrl).toContain('otpauth://totp/');
  });

  it('rejects a TOTP enroll without a valid step-up challenge, creating no pending method', async () => {
    const { user } = await helpers.registerUser({
      email: 'totp-enroll-no-stepup@example.com',
      username: 'totp_enroll_no_stepup',
      phone: '+2348055555591',
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );

    await request(ctx.app.getHttpServer())
      .post('/mfa/totp/enroll')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        challengeId: '00000000-0000-0000-0000-000000000000',
        code: '123456',
      })
      .expect(404);

    const method = await ctx.mfaMethodRepo.findOneBy({
      userId: user.id,
      type: 'totp',
    });
    expect(method).toBeNull();
  });

  it("rejects a TOTP enroll using another user's step-up challenge", async () => {
    const { user: userA } = await helpers.registerUser({
      email: 'totp-enroll-owner-a@example.com',
      username: 'totp_enroll_owner_a',
      phone: '+2348055555592',
    });
    const { tokens: tokensA } = await helpers.loginAndVerify(
      userA.email,
      'a-strong-unique-passphrase',
    );
    const { user: userB } = await helpers.registerUser({
      email: 'totp-enroll-owner-b@example.com',
      username: 'totp_enroll_owner_b',
      phone: '+2348055555593',
    });
    const { tokens: tokensB } = await helpers.loginAndVerify(
      userB.email,
      'a-strong-unique-passphrase',
    );

    const { challengeId, code } = await initiateTotpEnrollStepUp(
      tokensA.accessToken,
    );

    await request(ctx.app.getHttpServer())
      .post('/mfa/totp/enroll')
      .set('Authorization', `Bearer ${tokensB.accessToken}`)
      .send({ challengeId, code })
      .expect(410);

    const methodB = await ctx.mfaMethodRepo.findOneBy({
      userId: userB.id,
      type: 'totp',
    });
    expect(methodB).toBeNull();
  });
});
