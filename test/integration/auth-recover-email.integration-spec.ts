import { randomUUID } from 'crypto';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
} from './support/withdrawals-test-context';
import {
  PASSWORD_RESET_SUBJECT,
  createAuthTestHelpers,
  waitFor,
} from './support/auth-test-helpers';
import { createAccountControlsHelpers } from './support/account-controls-helpers';
import {
  NEW_PASSWORD,
  OWNER_PIN,
  createSelfLockHelpers,
} from './support/self-lock-helpers';
import { TEST_INTERNAL_API_SECRET } from './support/test-app-config';
import { errorOf } from './support/api-response';

jest.setTimeout(180_000);

describe('Reviewer email recovery', () => {
  let ctx: WithdrawalsTestContext;
  let auth: ReturnType<typeof createAuthTestHelpers>;
  const h = createAccountControlsHelpers(() => ctx);
  let s: ReturnType<typeof createSelfLockHelpers>;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
    auth = createAuthTestHelpers(ctx);
    s = createSelfLockHelpers(() => ctx, auth, h);
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  const recover = (
    userId: string,
    newEmail: string,
    headers: Record<string, string> = {
      'X-Internal-Secret': TEST_INTERNAL_API_SECRET,
      'X-Reviewer-Id': 'reviewer-12',
    },
  ) =>
    s
      .http()
      .post(`/internal/risk/users/${userId}/recover-email`)
      .set(headers)
      .send({ newEmail });

  const freshEmail = () => {
    seq += 1;
    return `recovered-${seq}@example.com`;
  };

  it('needs the internal secret and a reviewer id', async () => {
    const owner = await s.seedSignedInOwner();
    const newEmail = freshEmail();

    await recover(owner.userId, newEmail, {}).expect(401);
    await recover(owner.userId, newEmail, {
      'X-Internal-Secret': TEST_INTERNAL_API_SECRET,
    }).expect(401);
    await recover(owner.userId, newEmail, {
      'X-Internal-Secret': 'wrong-secret-wrong-secret-wrong-secret',
      'X-Reviewer-Id': 'reviewer-12',
    }).expect(401);

    const user = await ctx.userRepo.findOneByOrFail({ id: owner.userId });
    expect(user.email).toBe(owner.email);
  });

  it('restores the address as verified, audits the reviewer and cuts off the old address', async () => {
    const owner = await s.seedSignedInOwner();
    await s
      .http()
      .post('/auth/password-reset/request')
      .send({ email: owner.email })
      .expect(200);
    await waitFor(() =>
      ctx.emailAdapter.sent.some(
        (m) => m.to === owner.email && m.subject === PASSWORD_RESET_SUBJECT,
      ),
    );
    const staleResetCode = (
      await auth.waitForPasswordResetEmail(owner.email)
    ).text.match(/\b\d{6}\b/)![0];
    const newEmail = freshEmail();

    await recover(owner.userId, newEmail).expect(204);

    const user = await ctx.userRepo.findOneByOrFail({ id: owner.userId });
    expect(user.email).toBe(newEmail);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.securityCooldownUntil!.getTime()).toBeGreaterThan(Date.now());
    const [event] = await s.auditFor(owner.userId, 'email_recovered');
    expect(event).toMatchObject({
      actorType: 'reviewer',
      actorId: 'reviewer-12',
      metadata: { previousEmail: owner.email, newEmail },
    });
    expect(
      await ctx.sessionRepo.countBy({ userId: owner.userId, status: 'active' }),
    ).toBe(0);
    const staleReset = await s
      .http()
      .post('/auth/password-reset/complete')
      .send({
        code: staleResetCode,
        newPassword: NEW_PASSWORD,
        revokeOtherSessions: false,
      });
    expect(errorOf(staleReset).code).toBe('VERIFICATION_CODE_INVALID');
  });

  it('gets the owner back in: locked by the link, recovered, reset to the new address, unlocked', async () => {
    const owner = await s.seedSignedInOwner();
    await ctx.userRepo.update(
      { id: owner.userId },
      { email: 'attacker-owned@example.com' },
    );
    await s.lockByLink(s.linkTokenFor(owner.userId)).expect(200);
    const newEmail = freshEmail();
    await recover(owner.userId, newEmail).expect(204);

    await s.resetPassword(newEmail);
    const { tokens } = await auth.loginAndVerify(newEmail, NEW_PASSWORD);
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

  it('does not unlock the account by itself', async () => {
    const owner = await s.seedSignedInOwner();
    await s.lockInApp(owner.accessToken).expect(200);

    await recover(owner.userId, freshEmail()).expect(204);

    expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
  });

  it('refuses an address that belongs to another account', async () => {
    const owner = await s.seedSignedInOwner();
    const other = await s.seedSignedInOwner();

    const res = await recover(owner.userId, other.email).expect(409);

    expect(errorOf(res).code).toBe('EMAIL_ALREADY_REGISTERED');
    const user = await ctx.userRepo.findOneByOrFail({ id: owner.userId });
    expect(user.email).toBe(owner.email);
    expect(await s.auditFor(owner.userId, 'email_recovered')).toHaveLength(0);
  });

  it('answers 404 for an unknown user and 400 for a malformed id', async () => {
    const res = await recover(randomUUID(), freshEmail()).expect(404);
    expect(errorOf(res).code).toBe('USER_NOT_FOUND');
    await recover('not-a-uuid', freshEmail()).expect(400);
  });
});
