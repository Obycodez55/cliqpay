import {
  AccountLockedException,
  InvalidCredentialsException,
  InvalidRefreshTokenException,
  SessionRevokedException,
} from '../../src/modules/auth/internal/errors';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import {
  createAuthTestHelpers,
  TEST_DEVICE,
  waitFor,
} from './support/auth-test-helpers';

jest.setTimeout(120_000);

describe('login, sessions, and lockout', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  it('challenges on an untrusted device, then issues a token pair and a trusted session on verify', async () => {
    const { user } = await helpers.registerUser({
      email: 'login-ok@example.com',
      username: 'login_ok',
      phone: '+2348044444401',
    });

    const { tokens, trustedDeviceToken } = await helpers.loginAndVerify(
      'login-ok@example.com',
      'a-strong-unique-passphrase',
    );

    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresIn).toBe(15 * 60);
    expect(typeof trustedDeviceToken).toBe('string');

    const session = await ctx.sessionRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(session.status).toBe('active');
    expect(session.previousTokenHash).toBeNull();
    expect(session.currentTokenHash).toHaveLength(64); // sha256 hex
    expect(session.trustedDeviceId).not.toBeNull();
    expect(session.device).toEqual(TEST_DEVICE);

    const device = await ctx.trustedDeviceRepo.findOneByOrFail({
      id: session.trustedDeviceId!,
    });
    expect(device.userId).toBe(user.id);
    expect(device.device).toEqual(TEST_DEVICE);
  });

  it('rejects an unknown email and a wrong password identically, without creating a session', async () => {
    await helpers.registerUser({
      email: 'login-bad@example.com',
      username: 'login_bad',
      phone: '+2348044444402',
    });

    await expect(
      ctx.authService.login(
        { email: 'no-such-user@example.com', password: 'whatever' },
        null,
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);

    await expect(
      ctx.authService.login(
        { email: 'login-bad@example.com', password: 'wrong-password' },
        null,
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
  });

  it('rotates the refresh token on refresh(), and the old token becomes a reuse signal', async () => {
    await helpers.registerUser({
      email: 'rotate@example.com',
      username: 'rotate_user',
      phone: '+2348044444403',
    });
    const { tokens } = await helpers.loginAndVerify(
      'rotate@example.com',
      'a-strong-unique-passphrase',
    );
    const firstToken = tokens.refreshToken;

    const { refreshToken: secondToken } = await ctx.authService.refresh({
      refreshToken: firstToken,
    });
    expect(secondToken).not.toBe(firstToken);

    // Normal rotation: the new token works, rotating again.
    const { refreshToken: thirdToken } = await ctx.authService.refresh({
      refreshToken: secondToken,
    });
    expect(thirdToken).not.toBe(secondToken);

    // Replaying the very first (now two generations stale) token isn't
    // caught by the one-generation window — only the immediately-superseded
    // token is. Replaying the token one generation back (secondToken, which
    // is now previousTokenHash) is the reuse case that must revoke.
    const emailsBefore = ctx.emailAdapter.sent.length;
    await expect(
      ctx.authService.refresh({ refreshToken: secondToken }),
    ).rejects.toBeInstanceOf(SessionRevokedException);

    // The session is now fully revoked — even the latest valid token stops working.
    await expect(
      ctx.authService.refresh({ refreshToken: thirdToken }),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenException);

    // The reuse-detected revoke also fires a security_alert through the
    // real domain-events queue — not just an EventBusService.publish()
    // call in isolation (that's covered by the unit test).
    await waitFor(() => ctx.emailAdapter.sent.length > emailsBefore);
    expect(ctx.emailAdapter.sent.at(-1)).toMatchObject({
      to: 'rotate@example.com',
    });
  });

  it('rejects an unrecognized refresh token with no side effects', async () => {
    await helpers.registerUser({
      email: 'unknown-token@example.com',
      username: 'unknown_token_user',
      phone: '+2348044444404',
    });
    await helpers.loginAndVerify(
      'unknown-token@example.com',
      'a-strong-unique-passphrase',
    );

    const before = await ctx.sessionRepo.find();

    await expect(
      ctx.authService.refresh({ refreshToken: 'never-issued-token' }),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenException);

    const after = await ctx.sessionRepo.find();
    expect(after).toEqual(before);
  });

  it('logout revokes the session and the refresh token stops working', async () => {
    const { user } = await helpers.registerUser({
      email: 'logout@example.com',
      username: 'logout_user',
      phone: '+2348044444405',
    });
    const { tokens } = await helpers.loginAndVerify(
      'logout@example.com',
      'a-strong-unique-passphrase',
    );

    await ctx.authService.logout({ refreshToken: tokens.refreshToken });

    const session = await ctx.sessionRepo.findOneByOrFail({
      userId: user.id,
    });
    expect(session.status).toBe('revoked');
    await expect(
      ctx.authService.refresh({ refreshToken: tokens.refreshToken }),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenException);
  });

  it('locks the account for 15 minutes after 5 consecutive failed attempts', async () => {
    await helpers.registerUser({
      email: 'lockout@example.com',
      username: 'lockout_user',
      phone: '+2348044444406',
    });

    for (let i = 0; i < 4; i++) {
      await expect(
        ctx.authService.login(
          { email: 'lockout@example.com', password: 'wrong-password' },
          null,
          TEST_DEVICE,
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
    }

    // 5th failure locks the account.
    await expect(
      ctx.authService.login(
        { email: 'lockout@example.com', password: 'wrong-password' },
        null,
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);

    const lockedUser = await ctx.userRepo.findOneByOrFail({
      email: 'lockout@example.com',
    });
    const locked = await ctx.credentialRepo.findOneByOrFail({
      userId: lockedUser.id,
    });
    expect(locked.failedLoginAttempts).toBe(5);
    expect(locked.lockedUntil).toBeInstanceOf(Date);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Even the correct password is rejected while locked.
    await expect(
      ctx.authService.login(
        {
          email: 'lockout@example.com',
          password: 'a-strong-unique-passphrase',
        },
        null,
        TEST_DEVICE,
      ),
    ).rejects.toBeInstanceOf(AccountLockedException);
  });
});
