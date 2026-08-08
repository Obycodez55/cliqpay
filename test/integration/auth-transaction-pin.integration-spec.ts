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
  waitFor,
} from './support/auth-test-helpers';

jest.setTimeout(120_000);

const CURRENT_PASSWORD = 'a-strong-unique-passphrase';

describe('transaction PIN — set, change, reset, lockout', () => {
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
    path: string,
  ): Promise<{ challengeId: string; code: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    const challengeId = (res.body as { challengeId: string }).challengeId;
    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(SIGN_IN_CODE_SUBJECT).text,
    );
    return { challengeId, code };
  }

  async function setUpUser(overrides: Record<string, unknown>) {
    const { user } = await helpers.registerUser(overrides);
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      CURRENT_PASSWORD,
    );
    return { user, tokens };
  }

  describe('set', () => {
    it('sets the PIN for an account with none yet', async () => {
      const { user, tokens } = await setUpUser({
        email: 'pin-set-happy@example.com',
        username: 'pin_set_happy',
        phone: '+2348044400001',
      });
      const { challengeId, code } = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/set/step-up',
      );

      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/set')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ pin: '4837', challengeId, code })
        .expect(204);

      const credential = await ctx.credentialRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(credential.transactionPinHash).not.toBeNull();
    });

    it('rejects setting a PIN when one is already set', async () => {
      const { tokens } = await setUpUser({
        email: 'pin-set-twice@example.com',
        username: 'pin_set_twice',
        phone: '+2348044400002',
      });
      const first = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/set/step-up',
      );
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/set')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ pin: '4837', challengeId: first.challengeId, code: first.code })
        .expect(204);

      const second = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/set/step-up',
      );
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/set')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({
          pin: '9182',
          challengeId: second.challengeId,
          code: second.code,
        })
        .expect(409);
    });

    it.each(['1111', '0000', '1234', '4321'])(
      'rejects a weak PIN (%s) at set time',
      async (weakPin) => {
        const { tokens } = await setUpUser({
          email: `pin-set-weak-${weakPin}@example.com`,
          username: `pin_set_weak_${weakPin}`,
          phone: `+234804440${weakPin}`,
        });
        const { challengeId, code } = await initiateStepUp(
          tokens.accessToken,
          '/auth/transaction-pin/set/step-up',
        );

        await request(ctx.app.getHttpServer())
          .post('/auth/transaction-pin/set')
          .set('Authorization', `Bearer ${tokens.accessToken}`)
          .send({ pin: weakPin, challengeId, code })
          .expect(400);
      },
    );

    it('rejects an unauthenticated step-up request', async () => {
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/set/step-up')
        .send({})
        .expect(401);
    });
  });

  describe('change', () => {
    async function setUpUserWithPin(overrides: Record<string, unknown>) {
      const { user, tokens } = await setUpUser(overrides);
      const { challengeId, code } = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/set/step-up',
      );
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/set')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ pin: '4837', challengeId, code })
        .expect(204);
      return { user, tokens };
    }

    it('changes the PIN given the correct current PIN', async () => {
      const { user, tokens } = await setUpUserWithPin({
        email: 'pin-change-happy@example.com',
        username: 'pin_change_happy',
        phone: '+2348044400010',
      });
      const before = await ctx.credentialRepo.findOneByOrFail({
        userId: user.id,
      });

      const { challengeId, code } = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/change/step-up',
      );
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/change')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ currentPin: '4837', newPin: '9182', challengeId, code })
        .expect(204);

      const after = await ctx.credentialRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(after.transactionPinHash).not.toBe(before.transactionPinHash);
    });

    it('rejects the wrong current PIN, leaving the hash unchanged', async () => {
      const { user, tokens } = await setUpUserWithPin({
        email: 'pin-change-wrong@example.com',
        username: 'pin_change_wrong',
        phone: '+2348044400011',
      });
      const before = await ctx.credentialRepo.findOneByOrFail({
        userId: user.id,
      });

      const { challengeId, code } = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/change/step-up',
      );
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/change')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ currentPin: '0000', newPin: '9182', challengeId, code })
        .expect(401);

      const after = await ctx.credentialRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(after.transactionPinHash).toBe(before.transactionPinHash);
      expect(after.failedPinAttempts).toBe(1);
    });

    it('locks money movement for 15 minutes after 3 wrong attempts, and publishes a security alert', async () => {
      const { user, tokens } = await setUpUserWithPin({
        email: 'pin-change-lockout@example.com',
        username: 'pin_change_lockout',
        phone: '+2348044400012',
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { challengeId, code } = await initiateStepUp(
          tokens.accessToken,
          '/auth/transaction-pin/change/step-up',
        );
        await request(ctx.app.getHttpServer())
          .post('/auth/transaction-pin/change')
          .set('Authorization', `Bearer ${tokens.accessToken}`)
          .send({ currentPin: '0000', newPin: '9182', challengeId, code })
          .expect(401);
      }

      const locked = await ctx.credentialRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(locked.failedPinAttempts).toBe(3);
      expect(locked.pinLockedUntil).not.toBeNull();
      expect(locked.pinLockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // A 4th attempt, this time with the correct PIN, is still rejected —
      // the lock blocks money movement regardless of whether the PIN is
      // now typed correctly.
      const { challengeId, code } = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/change/step-up',
      );
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/change')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ currentPin: '4837', newPin: '9182', challengeId, code })
        .expect(423);

      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === user.email &&
            m.subject === 'Security alert on your Cliqpay account',
        ),
      );
    });

    it('does not block login, profile reads, or PIN reset while the PIN is locked', async () => {
      const { user, tokens } = await setUpUserWithPin({
        email: 'pin-lock-scope@example.com',
        username: 'pin_lock_scope',
        phone: '+2348044400013',
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { challengeId, code } = await initiateStepUp(
          tokens.accessToken,
          '/auth/transaction-pin/change/step-up',
        );
        await request(ctx.app.getHttpServer())
          .post('/auth/transaction-pin/change')
          .set('Authorization', `Bearer ${tokens.accessToken}`)
          .send({ currentPin: '0000', newPin: '9182', challengeId, code })
          .expect(401);
      }
      const locked = await ctx.credentialRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(locked.pinLockedUntil).not.toBeNull();

      // Login is unaffected — a fresh loginAndVerify still succeeds.
      await helpers.loginAndVerify(user.email, CURRENT_PASSWORD);

      // Profile reads are unaffected.
      await request(ctx.app.getHttpServer())
        .get('/profile')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      // PIN reset stays reachable while locked.
      const { challengeId, code } = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/reset/step-up',
      );
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/reset')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ newPin: '9182', challengeId, code })
        .expect(204);
    });
  });

  describe('reset', () => {
    it('sets a new PIN and clears failed_pin_attempts/pin_locked_until', async () => {
      const { user, tokens } = await setUpUser({
        email: 'pin-reset-happy@example.com',
        username: 'pin_reset_happy',
        phone: '+2348044400020',
      });
      const setUp = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/set/step-up',
      );
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/set')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ pin: '4837', challengeId: setUp.challengeId, code: setUp.code })
        .expect(204);

      // Drive the account into a locked state via wrong current-PIN attempts.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { challengeId, code } = await initiateStepUp(
          tokens.accessToken,
          '/auth/transaction-pin/change/step-up',
        );
        await request(ctx.app.getHttpServer())
          .post('/auth/transaction-pin/change')
          .set('Authorization', `Bearer ${tokens.accessToken}`)
          .send({ currentPin: '0000', newPin: '9182', challengeId, code })
          .expect(401);
      }
      const locked = await ctx.credentialRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(locked.pinLockedUntil).not.toBeNull();

      const { challengeId, code } = await initiateStepUp(
        tokens.accessToken,
        '/auth/transaction-pin/reset/step-up',
      );
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/reset')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ newPin: '9182', challengeId, code })
        .expect(204);

      const reset = await ctx.credentialRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(reset.failedPinAttempts).toBe(0);
      expect(reset.pinLockedUntil).toBeNull();
      expect(reset.transactionPinHash).not.toBe(locked.transactionPinHash);
    });

    it('rejects an unauthenticated reset step-up request', async () => {
      await request(ctx.app.getHttpServer())
        .post('/auth/transaction-pin/reset/step-up')
        .send({})
        .expect(401);
    });
  });
});
