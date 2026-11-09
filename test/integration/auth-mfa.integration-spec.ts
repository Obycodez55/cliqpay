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
  stepUpCodeSubject,
  TEST_DEVICE,
  TEST_DEVICE_ID,
  TEST_DEVICE_KEY,
  wrongCodeFor,
} from './support/auth-test-helpers';
import { dataOf } from './support/api-response';

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

    const result = await ctx.sessionService.login(
      {
        email: 'untrusted@example.com',
        password: 'a-strong-unique-passphrase',
      },
      null,
      TEST_DEVICE_ID,
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
      ctx.sessionService.verifyMfaChallenge(
        {
          challengeId: result.challengeId,
          code: wrongCodeFor(correctCode),
          devicePublicKey: TEST_DEVICE_KEY.publicKeyRawBase64,
        },
        TEST_DEVICE_ID,
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(InvalidMfaCodeException);

    const { tokens, trustedDeviceToken } =
      await ctx.sessionService.verifyMfaChallenge(
        {
          challengeId: result.challengeId,
          code: correctCode,
          devicePublicKey: TEST_DEVICE_KEY.publicKeyRawBase64,
        },
        TEST_DEVICE_ID,
        TEST_DEVICE,
      );
    expect(tokens.tokenType).toBe('Bearer');
    expect(typeof trustedDeviceToken).toBe('string');
  });

  it('login from a device with a valid trusted-device token and signed challenge skips the MFA challenge', async () => {
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
    const result = await helpers.loginTrusted(
      'trusted@example.com',
      'a-strong-unique-passphrase',
      trustedDeviceToken,
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

    const result = await ctx.sessionService.login(
      {
        email: 'five-attempts@example.com',
        password: 'a-strong-unique-passphrase',
      },
      null,
      TEST_DEVICE_ID,
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
        ctx.sessionService.verifyMfaChallenge(
          {
            challengeId: result.challengeId,
            code: wrong,
            devicePublicKey: TEST_DEVICE_KEY.publicKeyRawBase64,
          },
          TEST_DEVICE_ID,
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
      ctx.sessionService.verifyMfaChallenge(
        {
          challengeId: result.challengeId,
          code: correctCode,
          devicePublicKey: TEST_DEVICE_KEY.publicKeyRawBase64,
        },
        TEST_DEVICE_ID,
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(MfaChallengeInvalidException);
  });

  it('rejects verification against a nonexistent challenge', async () => {
    await expect(
      ctx.sessionService.verifyMfaChallenge(
        {
          challengeId: '00000000-0000-0000-0000-000000000000',
          code: '123456',
          devicePublicKey: TEST_DEVICE_KEY.publicKeyRawBase64,
        },
        TEST_DEVICE_ID,
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(MfaChallengeNotFoundException);
  });
});

describe('MFA over HTTP — trusted-device header and the JWT guard', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('returns the trusted-device token in a header on verify, and presenting it with a signed challenge skips the next MFA', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'http-header@example.com',
        password: 'a-strong-unique-passphrase',
        firstName: 'Header',
        lastName: 'Monster',
        username: 'http_header_user',
        phone: '+2348055555599',
      })
      .expect(201);

    const loginRes = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .set('User-Agent', 'Cliqpay-Test-Client/1.0')
      .send({
        email: 'http-header@example.com',
        password: 'a-strong-unique-passphrase',
      })
      .expect(200);
    const loginBody = dataOf<LoginResponseDto>(loginRes);
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
      .send({
        challengeId,
        code,
        devicePublicKey: TEST_DEVICE_KEY.publicKeyRawBase64,
      })
      .expect(200);

    expect(verifyRes.headers['set-cookie']).toBeUndefined();
    const trustedDeviceToken = verifyRes.headers['x-trusted-device-token'];
    expect(typeof trustedDeviceToken).toBe('string');

    // Real request metadata, not the test-only TEST_DEVICE constant —
    // proves the controller actually reads req.ip/User-Agent rather than
    // relying on a fixed value.
    const httpUser = await ctx.userRepo.findOneByOrFail({
      email: 'http-header@example.com',
    });
    const httpDevice = await ctx.trustedDeviceRepo.findOneByOrFail({
      userId: httpUser.id,
    });
    expect(httpDevice.device.userAgent).toBe('Cliqpay-Test-Client/1.0');
    expect(httpDevice.device.ipAddress).toEqual(expect.any(String));
    expect(httpDevice.device.ipAddress.length).toBeGreaterThan(0);
    expect(httpDevice.deviceId).toBe(TEST_DEVICE_ID);
    expect(httpDevice.publicKey).toBe(TEST_DEVICE_KEY.publicKeySpkiBase64);

    const challengeRes = await request(ctx.app.getHttpServer())
      .post('/auth/device-challenge')
      .send({ purpose: 'login' })
      .expect(200);
    const { nonce } = dataOf<{ nonce: string }>(challengeRes);

    const secondLoginRes = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .set('X-Trusted-Device-Token', trustedDeviceToken)
      .send({
        email: 'http-header@example.com',
        password: 'a-strong-unique-passphrase',
        nonce,
        signature: TEST_DEVICE_KEY.signChallenge('login', nonce),
      })
      .expect(200);
    const secondLoginBody = dataOf<LoginResponseDto>(secondLoginRes);
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
    const challengeId = dataOf<{ challengeId: string }>(res).challengeId;
    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(
        stepUpCodeSubject('set up an authenticator app'),
      ).text,
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

    const body = dataOf<EnrollTotpResponseDto>(res);
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
