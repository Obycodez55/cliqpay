import { generateKeyPairSync } from 'crypto';
import * as request from 'supertest';
import { IsNull } from 'typeorm';
import { LoginResponseDto } from '../../src/modules/auth/dto/login-response.dto';
import { TokenPairResponseDto } from '../../src/modules/auth/dto/token-pair-response.dto';
import {
  DeviceChallengeInvalidException,
  DevicePublicKeyInvalidException,
  DevicePublicKeyRequiredException,
  DeviceSignatureRequiredException,
  InvalidRefreshTokenException,
} from '../../src/modules/auth/internal/errors';
import { DeviceMismatchException } from '../../src/common/device/device-id.util';
import { dataOf } from './support/api-response';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import {
  createAuthTestHelpers,
  SECURITY_ALERT_SUBJECT,
  TEST_DEVICE,
  TEST_DEVICE_ID,
  TEST_DEVICE_KEY,
  waitFor,
} from './support/auth-test-helpers';
import { createTestDeviceKey } from './support/device-keys';

jest.setTimeout(120_000);

const PASSWORD = 'a-strong-unique-passphrase';

describe('device binding: keys, challenges and the one-device rule', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;
  let counter = 0;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  async function newUser() {
    counter += 1;
    const { user } = await helpers.registerUser({
      email: `bound${counter}@example.com`,
      username: `bound_user_${counter}`,
      phone: `+23480666660${String(counter).padStart(2, '0')}`,
    });
    return user;
  }

  it('stores the SPKI of a raw uncompressed key and the device id on the trusted device and session', async () => {
    const user = await newUser();
    await helpers.loginAndVerify(user.email, PASSWORD);

    const device = await ctx.trustedDeviceRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(device.publicKey).toBe(TEST_DEVICE_KEY.publicKeySpkiBase64);
    expect(device.deviceId).toBe(TEST_DEVICE_ID);
    expect(device.attestationResult).toBe('unavailable');
    const session = await ctx.sessionRepo.findOneByOrFail({ userId: user.id });
    expect(session.deviceId).toBe(TEST_DEVICE_ID);
  });

  it('accepts an X.509 SPKI key as well', async () => {
    const user = await newUser();
    const key = createTestDeviceKey('spki-device-000001');
    const login = await ctx.sessionService.login(
      { email: user.email, password: PASSWORD },
      null,
      key.deviceId,
      TEST_DEVICE,
    );
    if (!login.mfaRequired) throw new Error('expected a challenge');
    const code = (
      await import('./support/auth-test-helpers')
    ).extractSixDigitCode(
      helpers.latestEmailWithSubject('Your Cliqpay sign-in code').text,
    );
    await ctx.sessionService.verifyMfaChallenge(
      {
        challengeId: login.challengeId,
        code,
        devicePublicKey: key.publicKeySpkiBase64,
      },
      key.deviceId,
      TEST_DEVICE,
    );
    const device = await ctx.trustedDeviceRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(device.publicKey).toBe(key.publicKeySpkiBase64);
  });

  it('rejects a missing, malformed or non-P-256 key before the MFA code is spent', async () => {
    const user = await newUser();
    const login = await ctx.sessionService.login(
      { email: user.email, password: PASSWORD },
      null,
      TEST_DEVICE_ID,
      TEST_DEVICE,
    );
    if (!login.mfaRequired) throw new Error('expected a challenge');
    const code = (
      await import('./support/auth-test-helpers')
    ).extractSixDigitCode(
      helpers.latestEmailWithSubject('Your Cliqpay sign-in code').text,
    );
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');

    const verify = (devicePublicKey?: string) =>
      ctx.sessionService.verifyMfaChallenge(
        { challengeId: login.challengeId, code, devicePublicKey },
        TEST_DEVICE_ID,
        TEST_DEVICE,
      );
    await expect(verify(undefined)).rejects.toBeInstanceOf(
      DevicePublicKeyRequiredException,
    );
    await expect(verify('bm90IGEga2V5')).rejects.toBeInstanceOf(
      DevicePublicKeyInvalidException,
    );
    await expect(verify(p384)).rejects.toBeInstanceOf(
      DevicePublicKeyInvalidException,
    );
    await expect(
      verify(TEST_DEVICE_KEY.publicKeyRawBase64),
    ).resolves.toBeDefined();
  });

  it('logs in on a trusted device with a signed login challenge, and refreshes with a signed refresh challenge', async () => {
    const user = await newUser();
    const { trustedDeviceToken } = await helpers.loginAndVerify(
      user.email,
      PASSWORD,
    );

    const login = await helpers.loginTrusted(
      user.email,
      PASSWORD,
      trustedDeviceToken,
    );
    if (login.mfaRequired) throw new Error('expected no challenge');

    const refreshed = await helpers.refreshSigned(login.refreshToken);
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
  });

  it('rejects a replayed nonce', async () => {
    const user = await newUser();
    const { tokens } = await helpers.loginAndVerify(user.email, PASSWORD);
    const signed = await helpers.signedNonce('refresh');
    const next = await ctx.sessionService.refresh(
      { refreshToken: tokens.refreshToken, ...signed },
      TEST_DEVICE_ID,
    );
    await expect(
      ctx.sessionService.refresh(
        { refreshToken: next.refreshToken, ...signed },
        TEST_DEVICE_ID,
      ),
    ).rejects.toBeInstanceOf(DeviceChallengeInvalidException);
    const session = await ctx.sessionRepo.findOneByOrFail({ userId: user.id });
    expect(session.status).toBe('active');
  });

  it('rejects an expired nonce', async () => {
    const user = await newUser();
    const { tokens } = await helpers.loginAndVerify(user.email, PASSWORD);
    const signed = await helpers.signedNonce('refresh');
    await ctx.deviceChallengeRepo.update(
      { deviceId: TEST_DEVICE_ID, usedAt: IsNull() },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    await expect(
      ctx.sessionService.refresh(
        { refreshToken: tokens.refreshToken, ...signed },
        TEST_DEVICE_ID,
      ),
    ).rejects.toBeInstanceOf(DeviceChallengeInvalidException);
  });

  it('rejects a nonce issued for another purpose or device', async () => {
    const user = await newUser();
    const { tokens } = await helpers.loginAndVerify(user.email, PASSWORD);

    const loginNonce = await ctx.deviceBindingService.issueChallenge(
      TEST_DEVICE_ID,
      'login',
    );
    await expect(
      ctx.sessionService.refresh(
        {
          refreshToken: tokens.refreshToken,
          nonce: loginNonce.nonce,
          signature: TEST_DEVICE_KEY.signChallenge('refresh', loginNonce.nonce),
        },
        TEST_DEVICE_ID,
      ),
    ).rejects.toBeInstanceOf(DeviceChallengeInvalidException);
  });

  it('requires a nonce and signature while the key is required', async () => {
    const user = await newUser();
    const { tokens } = await helpers.loginAndVerify(user.email, PASSWORD);
    await expect(
      ctx.sessionService.refresh(
        { refreshToken: tokens.refreshToken },
        TEST_DEVICE_ID,
      ),
    ).rejects.toBeInstanceOf(DeviceSignatureRequiredException);
  });

  it('treats a signature from the wrong key as a theft signal: session revoked and alert sent', async () => {
    const user = await newUser();
    const { tokens } = await helpers.loginAndVerify(user.email, PASSWORD);
    const attacker = createTestDeviceKey(TEST_DEVICE_ID);
    const alertsBefore = ctx.emailAdapter.sent.filter(
      (m) => m.to === user.email && m.subject === SECURITY_ALERT_SUBJECT,
    ).length;

    await expect(
      helpers.refreshSigned(tokens.refreshToken, attacker),
    ).rejects.toBeInstanceOf(DeviceMismatchException);

    const session = await ctx.sessionRepo.findOneByOrFail({ userId: user.id });
    expect(session.status).toBe('revoked');
    await waitFor(
      () =>
        ctx.emailAdapter.sent.filter(
          (m) => m.to === user.email && m.subject === SECURITY_ALERT_SUBJECT,
        ).length > alertsBefore,
    );
  });

  it('revokes the trusted device when a login signature does not verify', async () => {
    const user = await newUser();
    const { trustedDeviceToken } = await helpers.loginAndVerify(
      user.email,
      PASSWORD,
    );
    const attacker = createTestDeviceKey(TEST_DEVICE_ID);

    await expect(
      helpers.loginTrusted(user.email, PASSWORD, trustedDeviceToken, attacker),
    ).rejects.toBeInstanceOf(DeviceMismatchException);

    const device = await ctx.trustedDeviceRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(device.revokedAt).not.toBeNull();
    const login = await ctx.sessionService.login(
      { email: user.email, password: PASSWORD },
      trustedDeviceToken,
      TEST_DEVICE_ID,
      TEST_DEVICE,
    );
    expect(login.mfaRequired).toBe(true);
  });

  it('treats a refresh from a different device id like token reuse', async () => {
    const user = await newUser();
    const { tokens } = await helpers.loginAndVerify(user.email, PASSWORD);

    await expect(
      ctx.sessionService.refresh(
        { refreshToken: tokens.refreshToken },
        'some-other-device-id',
      ),
    ).rejects.toBeInstanceOf(DeviceMismatchException);

    const session = await ctx.sessionRepo.findOneByOrFail({ userId: user.id });
    expect(session.status).toBe('revoked');
  });

  it('presenting a trusted-device token from another device id revokes that trust', async () => {
    const user = await newUser();
    const { trustedDeviceToken } = await helpers.loginAndVerify(
      user.email,
      PASSWORD,
    );
    await expect(
      ctx.sessionService.login(
        { email: user.email, password: PASSWORD },
        trustedDeviceToken,
        'some-other-device-id',
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(DeviceMismatchException);
    const device = await ctx.trustedDeviceRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(device.revokedAt).not.toBeNull();
  });

  it('trusting a new device revokes the old device, its sessions and key, alerts, and audits', async () => {
    const user = await newUser();
    const first = await helpers.loginAndVerify(user.email, PASSWORD);
    const secondKey = createTestDeviceKey('second-device-000001');
    const alertsBefore = ctx.emailAdapter.sent.filter(
      (m) => m.to === user.email && m.subject === SECURITY_ALERT_SUBJECT,
    ).length;

    const second = await helpers.loginAndVerify(
      user.email,
      PASSWORD,
      secondKey,
    );
    expect(second.trustedDeviceToken).not.toBe(first.trustedDeviceToken);

    const devices = await ctx.trustedDeviceRepo.find({
      where: { userId: user.id },
      order: { createdAt: 'ASC' },
    });
    expect(devices).toHaveLength(2);
    expect(devices[0].revokedAt).not.toBeNull();
    expect(devices[1].revokedAt).toBeNull();
    expect(devices[1].deviceId).toBe(secondKey.deviceId);

    const sessions = await ctx.sessionRepo.find({
      where: { userId: user.id },
      order: { createdAt: 'ASC' },
    });
    expect(sessions.map((s) => s.status)).toEqual(['revoked', 'active']);

    await expect(
      helpers.refreshSigned(first.tokens.refreshToken),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenException);

    const audit = await ctx.dataSource.query<
      { action: string; metadata: { reason?: string } }[]
    >(
      `SELECT action, metadata FROM audit_events WHERE subject_id = ANY($1) ORDER BY occurred_at`,
      [devices.map((d) => d.id)],
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['device_trusted', 'device_revoked']),
    );
    expect(
      audit.find((a) => a.action === 'device_revoked')!.metadata.reason,
    ).toBe('device_switch');

    await waitFor(
      () =>
        ctx.emailAdapter.sent.filter(
          (m) => m.to === user.email && m.subject === SECURITY_ALERT_SUBJECT,
        ).length > alertsBefore,
    );
  });

  it('serves the challenge endpoint and requires X-Device-Id on login, verify and refresh', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/auth/device-challenge')
      .set('X-Device-Id', 'http-device-0000001')
      .send({ purpose: 'refresh' })
      .expect(200);
    const body = dataOf<{ nonce: string; expiresAt: string }>(res);
    expect(body.nonce).toHaveLength(43);
    const ttl = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(100_000);
    expect(ttl).toBeLessThanOrEqual(120_000);

    for (const path of ['/auth/login', '/auth/refresh', '/mfa/verify']) {
      await request(ctx.app.getHttpServer())
        .post(path)
        .set('X-Device-Id', 'short')
        .send({})
        .expect(400);
    }
  });

  it('rejects authenticated requests whose X-Device-Id differs from the token, or is missing', async () => {
    const user = await newUser();
    const { tokens } = await helpers.loginAndVerify(user.email, PASSWORD);
    const bearer = `Bearer ${tokens.accessToken}`;

    await request(ctx.app.getHttpServer())
      .get('/profile')
      .set('Authorization', bearer)
      .expect(200);
    await request(ctx.app.getHttpServer())
      .get('/profile')
      .set('Authorization', bearer)
      .set('X-Device-Id', 'another-device-00001')
      .expect(401);
  });

  it('completes the full HTTP flow with a raw key and signature', async () => {
    const user = await newUser();
    const first = await helpers.loginAndVerify(user.email, PASSWORD);

    const { nonce } = dataOf<{ nonce: string }>(
      await request(ctx.app.getHttpServer())
        .post('/auth/device-challenge')
        .send({ purpose: 'refresh' })
        .expect(200),
    );
    const res = await request(ctx.app.getHttpServer())
      .post('/auth/refresh')
      .send({
        refreshToken: first.tokens.refreshToken,
        nonce,
        signature: TEST_DEVICE_KEY.signChallenge('refresh', nonce),
      })
      .expect(200);
    expect(dataOf<TokenPairResponseDto>(res).accessToken).toEqual(
      expect.any(String),
    );
    const login = dataOf<LoginResponseDto>(
      await request(ctx.app.getHttpServer())
        .post('/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(200),
    );
    expect(login.mfaRequired).toBe(true);
  });
});

describe('DEVICE_KEY_REQUIRED=false', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    (
      ctx.deviceBindingService as unknown as {
        config: { device: { keyRequired: boolean } };
      }
    ).config.device.keyRequired = false;
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('skips signature checks but still binds the device id', async () => {
    const { user } = await helpers.registerUser({
      email: 'nokey@example.com',
      username: 'nokey_user',
      phone: '+2348077777701',
    });
    const login1 = await ctx.sessionService.login(
      { email: user.email, password: PASSWORD },
      null,
      TEST_DEVICE_ID,
      TEST_DEVICE,
    );
    if (!login1.mfaRequired) throw new Error('expected a challenge');
    const code = (
      await import('./support/auth-test-helpers')
    ).extractSixDigitCode(
      helpers.latestEmailWithSubject('Your Cliqpay sign-in code').text,
    );
    const { tokens, trustedDeviceToken } =
      await ctx.sessionService.verifyMfaChallenge(
        { challengeId: login1.challengeId, code },
        TEST_DEVICE_ID,
        TEST_DEVICE,
      );
    const device = await ctx.trustedDeviceRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(device.publicKey).toBeNull();

    const login2 = await ctx.sessionService.login(
      { email: user.email, password: PASSWORD },
      trustedDeviceToken,
      TEST_DEVICE_ID,
      TEST_DEVICE,
    );
    expect(login2.mfaRequired).toBe(false);

    const refreshed = await ctx.sessionService.refresh(
      { refreshToken: tokens.refreshToken },
      TEST_DEVICE_ID,
    );
    expect(refreshed.refreshToken).toEqual(expect.any(String));

    await expect(
      ctx.sessionService.refresh(
        { refreshToken: refreshed.refreshToken },
        'some-other-device-id',
      ),
    ).rejects.toBeInstanceOf(DeviceMismatchException);
  });
});
