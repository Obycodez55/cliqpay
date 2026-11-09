import { DeviceAttestationFailedException } from '../../src/modules/auth/internal/errors';
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
  TEST_DEVICE_ID,
  TEST_DEVICE_KEY,
} from './support/auth-test-helpers';

jest.setTimeout(120_000);

const PASSWORD = 'a-strong-unique-passphrase';

describe('device attestation modes', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;
  let counter = 0;

  const attestationConfig = () =>
    (
      ctx.deviceBindingService as unknown as {
        config: { device: { attestation: { mode: string } } };
      }
    ).config.device.attestation;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  async function verifyWith(attestationToken: string | null) {
    counter += 1;
    const { user } = await helpers.registerUser({
      email: `attest${counter}@example.com`,
      username: `attest_user_${counter}`,
      phone: `+23480888880${String(counter).padStart(2, '0')}`,
    });
    const login = await ctx.sessionService.login(
      { email: user.email, password: PASSWORD },
      null,
      TEST_DEVICE_ID,
      TEST_DEVICE,
    );
    if (!login.mfaRequired) throw new Error('expected a challenge');
    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );
    const { nonce } = await ctx.deviceBindingService.issueChallenge(
      TEST_DEVICE_ID,
      'register',
    );
    const run = () =>
      ctx.sessionService.verifyMfaChallenge(
        {
          challengeId: login.challengeId,
          code,
          devicePublicKey: TEST_DEVICE_KEY.publicKeyRawBase64,
          attestation: attestationToken
            ? { platform: 'ios', nonce, keyId: 'k', token: attestationToken }
            : undefined,
        },
        TEST_DEVICE_ID,
        TEST_DEVICE,
      );
    return { user, run, nonce };
  }

  const stored = (userId: string) =>
    ctx.trustedDeviceRepo
      .findOneByOrFail({ userId })
      .then((d) => d.attestationResult);

  it('shadow mode records a passed attestation', async () => {
    attestationConfig().mode = 'shadow';
    const { user, run } = await verifyWith('pass');
    await run();
    expect(await stored(user.id)).toBe('passed');
  });

  it('shadow mode records a failed attestation without blocking', async () => {
    attestationConfig().mode = 'shadow';
    const { user, run } = await verifyWith('bad-token');
    await expect(run()).resolves.toBeDefined();
    expect(await stored(user.id)).toBe('failed');
  });

  it('records unavailable when the device sends no attestation', async () => {
    attestationConfig().mode = 'shadow';
    const { user, run } = await verifyWith(null);
    await run();
    expect(await stored(user.id)).toBe('unavailable');
  });

  it('marks an attestation with a reused register nonce as failed', async () => {
    attestationConfig().mode = 'shadow';
    const { user, run } = await verifyWith('pass');
    await ctx.deviceChallengeRepo.update(
      { deviceId: TEST_DEVICE_ID },
      { usedAt: new Date() },
    );
    await run();
    expect(await stored(user.id)).toBe('failed');
  });

  it('enforce mode rejects a device that did not pass, trusting nothing', async () => {
    attestationConfig().mode = 'enforce';
    const { user, run } = await verifyWith('bad-token');
    await expect(run()).rejects.toBeInstanceOf(
      DeviceAttestationFailedException,
    );
    expect(await ctx.trustedDeviceRepo.countBy({ userId: user.id })).toBe(0);
  });

  it('enforce mode accepts a passing attestation', async () => {
    attestationConfig().mode = 'enforce';
    const { user, run } = await verifyWith('pass');
    await run();
    expect(await stored(user.id)).toBe('passed');
  });

  it('off mode skips verification and leaves the nonce unused', async () => {
    attestationConfig().mode = 'off';
    const { user, run } = await verifyWith('pass');
    await run();
    expect(await stored(user.id)).toBe('unavailable');
    const unused = await ctx.deviceChallengeRepo.find({
      where: { deviceId: TEST_DEVICE_ID, purpose: 'register' },
    });
    expect(unused.some((c) => c.usedAt === null)).toBe(true);
  });
});
