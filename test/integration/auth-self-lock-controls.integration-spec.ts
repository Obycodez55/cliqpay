import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
} from './support/withdrawals-test-context';
import { createAuthTestHelpers } from './support/auth-test-helpers';
import { createAccountControlsHelpers } from './support/account-controls-helpers';
import {
  NEW_PASSWORD,
  OWNER_PIN,
  createSelfLockHelpers,
} from './support/self-lock-helpers';
import { errorOf } from './support/api-response';

jest.setTimeout(180_000);

const LOCKED = 'ACCOUNT_SELF_LOCKED';

describe('Self-lock: what a locked account refuses and how it unlocks', () => {
  let ctx: WithdrawalsTestContext;
  let auth: ReturnType<typeof createAuthTestHelpers>;
  const h = createAccountControlsHelpers(() => ctx);
  let s: ReturnType<typeof createSelfLockHelpers>;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
    auth = createAuthTestHelpers(ctx);
    s = createSelfLockHelpers(() => ctx, auth, h);
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  async function expectLocked(res: Promise<{ status: number; body: unknown }>) {
    const settled = (await res) as Parameters<typeof errorOf>[0] & {
      status: number;
    };
    expect(settled.status).toBe(403);
    expect(errorOf(settled).code).toBe(LOCKED);
  }

  async function expectDead(res: Promise<{ status: number; body: unknown }>) {
    const settled = (await res) as Parameters<typeof errorOf>[0] & {
      status: number;
    };
    expect(settled.status).toBe(410);
    expect(['MFA_CHALLENGE_INVALID', 'VERIFICATION_CODE_INVALID']).toContain(
      errorOf(settled).code,
    );
  }

  describe('while locked, a session that was already open', () => {
    it.each([
      ['email', '/auth/change-email/step-up'],
      ['phone', '/auth/change-phone/step-up'],
      ['MFA', '/mfa/totp/enroll/step-up'],
      ['PIN set', '/auth/transaction-pin/set/step-up'],
      ['PIN change', '/auth/transaction-pin/change/step-up'],
      ['PIN reset', '/auth/transaction-pin/reset/step-up'],
      ['bank account', '/withdrawals/bank-accounts/step-up'],
      ['limit raise', '/wallet/limits/daily/raise/step-up'],
    ])('cannot start a %s change', async (_name, path) => {
      const owner = await s.seedSignedInOwner();
      await s.lockInApp(owner.accessToken).expect(200);

      await expectLocked(
        s.http().post(path).set(s.bearer(owner.accessToken)).send({}),
      );
    });

    it('cannot change the email with a challenge opened before the lock (it is dead)', async () => {
      const owner = await s.seedSignedInOwner();
      const { challengeId, code } = await s.stepUpCode(
        owner.accessToken,
        '/auth/change-email/step-up',
        'change your email address',
      );
      await s.lockInApp(owner.accessToken).expect(200);

      await expectDead(
        s
          .http()
          .post('/auth/change-email')
          .set(s.bearer(owner.accessToken))
          .send({ newEmail: 'attacker@example.com', challengeId, code }),
      );

      const user = await ctx.userRepo.findOneByOrFail({ id: owner.userId });
      expect(user.email).toBe(owner.email);
      expect(user.pendingEmail).toBeNull();
    });

    it('cannot confirm an email change started before the lock (its code is dead)', async () => {
      const owner = await s.seedSignedInOwner();
      const { challengeId, code } = await s.stepUpCode(
        owner.accessToken,
        '/auth/change-email/step-up',
        'change your email address',
      );
      await s
        .http()
        .post('/auth/change-email')
        .set(s.bearer(owner.accessToken))
        .send({ newEmail: 'attacker-confirm@example.com', challengeId, code })
        .expect(204);
      const sent = await auth.waitForVerificationEmail(
        'attacker-confirm@example.com',
      );
      const confirmCode = sent.text.match(/\b\d{6}\b/)![0];
      await s.lockInApp(owner.accessToken).expect(200);

      await expectDead(
        s
          .http()
          .post('/auth/change-email/confirm')
          .set(s.bearer(owner.accessToken))
          .send({ code: confirmCode, revokeOtherSessions: false }),
      );

      const user = await ctx.userRepo.findOneByOrFail({ id: owner.userId });
      expect(user.email).toBe(owner.email);
    });

    it('cannot change the PIN with a challenge it opened before the lock', async () => {
      const owner = await s.seedSignedInOwner();
      const { challengeId, code } = await s.stepUpCode(
        owner.accessToken,
        '/auth/transaction-pin/change/step-up',
        'change your transaction PIN',
      );
      const before = await ctx.credentialRepo.findOneByOrFail({
        userId: owner.userId,
      });
      await s.lockInApp(owner.accessToken).expect(200);

      await expectDead(
        s
          .http()
          .post('/auth/transaction-pin/change')
          .set(s.bearer(owner.accessToken))
          .send({ currentPin: OWNER_PIN, newPin: '7391', challengeId, code }),
      );

      const after = await ctx.credentialRepo.findOneByOrFail({
        userId: owner.userId,
      });
      expect(after.transactionPinHash).toBe(before.transactionPinHash);
    });

    it('cannot save a bank account with a challenge it opened before the lock', async () => {
      const owner = await s.seedSignedInOwner();
      const { challengeId, code } = await s.stepUpCode(
        owner.accessToken,
        '/withdrawals/bank-accounts/step-up',
        'save a bank account',
      );
      ctx.fakeAdapter.setResolveBankAccountResult('033', '0000000777', {
        status: 'resolved',
        bankName: 'United Bank for Africa',
        accountName: 'Attacker Account',
      });
      await s.lockInApp(owner.accessToken).expect(200);

      await expectDead(
        s
          .http()
          .post('/withdrawals/bank-accounts')
          .set(s.bearer(owner.accessToken))
          .send({
            bankCode: '033',
            accountNumber: '0000000777',
            challengeId,
            code,
          }),
      );

      expect(await ctx.bankAccountRepo.countBy({ userId: owner.userId })).toBe(
        0,
      );
    });

    it('cannot raise the daily limit with a challenge it opened before the lock', async () => {
      const owner = await s.seedSignedInOwner();
      await ctx.kycService.lowerDailyOutflowLimit(owner.userId, 1_000_000);
      const { challengeId, code } = await s.stepUpCode(
        owner.accessToken,
        '/wallet/limits/daily/raise/step-up',
        'raise your daily limit',
      );
      await s.lockInApp(owner.accessToken).expect(200);

      await expectDead(
        s
          .http()
          .post('/wallet/limits/daily/raise')
          .set(s.bearer(owner.accessToken))
          .send({ amount: 3_000_000, pin: OWNER_PIN, challengeId, code }),
      );
    });

    it('can still lower its daily limit', async () => {
      const owner = await s.seedSignedInOwner();
      await s.lockInApp(owner.accessToken).expect(200);

      await s
        .http()
        .post('/wallet/limits/daily/lower')
        .set(s.bearer(owner.accessToken))
        .send({ amount: 1_000_000, pin: OWNER_PIN })
        .expect(200);
    });
  });

  it('still allows a password reset by email while locked', async () => {
    const owner = await s.seedSignedInOwner();
    await s.lockInApp(owner.accessToken).expect(200);

    await s.resetPassword(owner.email);

    const credential = await ctx.credentialRepo.findOneByOrFail({
      userId: owner.userId,
    });
    const [lock] = await s.openSelfLocks(owner.userId);
    expect(credential.passwordResetAt!.getTime()).toBeGreaterThan(
      lock.createdAt.getTime(),
    );
    expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
  });

  describe('what was issued before the lock', () => {
    it('cannot be used: a reset code from before the lock is dead, a fresh one unlocks', async () => {
      const owner = await s.seedSignedInOwner();
      await s
        .http()
        .post('/auth/password-reset/request')
        .send({ email: owner.email })
        .expect(200);
      const oldCode = (
        await auth.waitForPasswordResetEmail(owner.email)
      ).text.match(/\b\d{6}\b/)![0];
      await s.lockInApp(owner.accessToken).expect(200);

      const res = await s.http().post('/auth/password-reset/complete').send({
        code: oldCode,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: false,
      });
      expect(errorOf(res).code).toBe('VERIFICATION_CODE_INVALID');
      const stale = await ctx.credentialRepo.findOneByOrFail({
        userId: owner.userId,
      });
      expect(stale.passwordResetAt).toBeNull();

      await ctx.verificationCodeRepo.update(
        { userId: owner.userId, purpose: 'password_reset' },
        { createdAt: new Date(Date.now() - 61_000) },
      );
      await s.resetPassword(owner.email);
      const { tokens } = await auth.loginAndVerify(owner.email, NEW_PASSWORD);
      const { challengeId, code } = await s.stepUpCode(
        tokens.accessToken,
        '/auth/unlock/step-up',
        'unlock your account',
      );
      await s
        .http()
        .post('/auth/unlock')
        .set(s.bearer(tokens.accessToken))
        .send({ challengeId, code, pin: OWNER_PIN })
        .expect(204);
      expect(await s.openSelfLocks(owner.userId)).toHaveLength(0);
    });

    it('cannot be used: a step-up challenge opened before the lock is dead', async () => {
      const owner = await s.seedSignedInOwner();
      const { challengeId, code } = await s.stepUpCode(
        owner.accessToken,
        '/auth/change-password/step-up',
        'change your password',
      );
      await s.lockInApp(owner.accessToken).expect(200);

      const res = await s
        .http()
        .post('/auth/change-password')
        .set(s.bearer(owner.accessToken))
        .send({
          challengeId,
          code,
          currentPassword: 'a-strong-unique-passphrase',
          newPassword: NEW_PASSWORD,
          revokeOtherSessions: false,
        });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(errorOf(res).code).toBe('MFA_CHALLENGE_INVALID');
    });
  });

  describe('unlocking', () => {
    async function unlockAttempt(accessToken: string, pin: string = OWNER_PIN) {
      const { challengeId, code } = await s.stepUpCode(
        accessToken,
        '/auth/unlock/step-up',
        'unlock your account',
      );
      return s
        .http()
        .post('/auth/unlock')
        .set(s.bearer(accessToken))
        .send({ challengeId, code, pin });
    }

    it('is refused without a password reset after the lock', async () => {
      const owner = await s.seedSignedInOwner();
      await s.lockInApp(owner.accessToken).expect(200);

      const res = await unlockAttempt(owner.accessToken);

      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('UNLOCK_REQUIRES_PASSWORD_RESET');
      expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
    });

    it('is refused when the only reset came before the lock', async () => {
      const owner = await s.seedSignedInOwner();
      await s.resetPassword(owner.email);
      await s.lockInApp(owner.accessToken).expect(200);

      const res = await unlockAttempt(owner.accessToken);

      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('UNLOCK_REQUIRES_PASSWORD_RESET');
      expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
    });

    it('works after a reset, a normal login, step-up and the PIN, and is audited', async () => {
      const owner = await s.seedSignedInOwner();
      const recipient = await h.seedUser('unlock-to', { balanceMinor: 0n });
      await s.lockByLink(s.linkTokenFor(owner.userId)).expect(200);
      await s.resetPassword(owner.email);
      const { tokens } = await auth.loginAndVerify(owner.email, NEW_PASSWORD);

      const res = await unlockAttempt(tokens.accessToken);

      expect(res.status).toBe(204);
      expect(await s.openSelfLocks(owner.userId)).toHaveLength(0);
      const [lifted] = await s.auditFor(owner.userId, 'restriction_lifted');
      expect(lifted).toMatchObject({
        actorType: 'user',
        actorId: owner.userId,
        metadata: { reason: 'self_lock' },
      });
      await expect(
        h.transfer(owner.userId, recipient.userId, 20_000),
      ).resolves.toBeDefined();
    });

    it('is refused with a wrong PIN', async () => {
      const owner = await s.seedSignedInOwner();
      await s.lockInApp(owner.accessToken).expect(200);
      await s.resetPassword(owner.email);
      const { tokens } = await auth.loginAndVerify(owner.email, NEW_PASSWORD);

      const res = await unlockAttempt(tokens.accessToken, '9999');

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('INVALID_TRANSACTION_PIN');
      expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
    });

    it('is refused for an account that is not locked', async () => {
      const owner = await s.seedSignedInOwner();

      const res = await unlockAttempt(owner.accessToken);

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('ACCOUNT_NOT_SELF_LOCKED');
    });

    it('needs a fresh reset after the account is locked again', async () => {
      const owner = await s.seedSignedInOwner();
      await s.lockInApp(owner.accessToken).expect(200);
      await s.resetPassword(owner.email);
      const { tokens } = await auth.loginAndVerify(owner.email, NEW_PASSWORD);
      expect((await unlockAttempt(tokens.accessToken)).status).toBe(204);

      await s.lockInApp(tokens.accessToken).expect(200);
      const res = await unlockAttempt(tokens.accessToken);

      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe('UNLOCK_REQUIRES_PASSWORD_RESET');
      expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
    });
  });
});
