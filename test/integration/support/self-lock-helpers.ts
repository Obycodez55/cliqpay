import * as request from 'supertest';
import { IsNull } from 'typeorm';
import { AccountRestriction } from '../../../src/modules/users/entities/account-restriction.entity';
import { AuditEvent } from '../../../src/shared/audit/entities/audit-event.entity';
import { signSelfLockToken } from '../../../src/shared/crypto/self-lock-token.util';
import { dataOf } from './api-response';
import {
  PASSWORD_RESET_SUBJECT,
  createAuthTestHelpers,
  extractSixDigitCode,
  stepUpCodeSubject,
  waitFor,
} from './auth-test-helpers';
import { createAccountControlsHelpers } from './account-controls-helpers';
import { TEST_SELF_LOCK_TOKEN_KEY } from './test-app-config';
import { WithdrawalsTestContext } from './withdrawals-test-context';

export const OWNER_PASSWORD = 'a-strong-unique-passphrase';
export const OWNER_PIN = '1234';
export const NEW_PASSWORD = 'another-strong-unique-passphrase';

export function createSelfLockHelpers(
  getCtx: () => WithdrawalsTestContext,
  auth: ReturnType<typeof createAuthTestHelpers>,
  h: ReturnType<typeof createAccountControlsHelpers>,
) {
  const http = () => request(getCtx().app.getHttpServer());

  async function seedSignedInOwner() {
    const owner = await h.seedOwner(auth, OWNER_PIN);
    await auth.agePastResendCooldown(owner.userId, 'email_verification');
    await auth.agePastResendCooldown(owner.userId, 'phone_verification');
    const { tokens } = await auth.loginAndVerify(owner.email, OWNER_PASSWORD);
    return { ...owner, accessToken: tokens.accessToken };
  }

  const linkTokenFor = (userId: string, now = new Date()) =>
    signSelfLockToken(
      Buffer.from(TEST_SELF_LOCK_TOKEN_KEY, 'hex'),
      userId,
      now,
    );

  const lockInApp = (accessToken: string) =>
    http()
      .post('/auth/self-lock')
      .set('Authorization', `Bearer ${accessToken}`);

  const lockByLink = (token: string) =>
    http().post('/auth/self-lock/token').send({ token });

  const bearer = (accessToken: string) => ({
    Authorization: `Bearer ${accessToken}`,
  });

  async function stepUpCode(
    accessToken: string,
    path: string,
    purpose: string,
  ): Promise<{ challengeId: string; code: string }> {
    const res = await http().post(path).set(bearer(accessToken)).send({});
    expect([200, 201]).toContain(res.status);
    return {
      challengeId: dataOf<{ challengeId: string }>(res).challengeId,
      code: extractSixDigitCode(
        auth.latestEmailWithSubject(stepUpCodeSubject(purpose)).text,
      ),
    };
  }

  async function resetPassword(email: string, newPassword = NEW_PASSWORD) {
    const before = getCtx().emailAdapter.sent.filter(
      (m) => m.to === email && m.subject === PASSWORD_RESET_SUBJECT,
    ).length;
    await http()
      .post('/auth/password-reset/request')
      .send({ email })
      .expect(200);
    await waitFor(
      () =>
        getCtx().emailAdapter.sent.filter(
          (m) => m.to === email && m.subject === PASSWORD_RESET_SUBJECT,
        ).length > before,
    );
    const code = extractSixDigitCode(
      (await auth.waitForPasswordResetEmail(email)).text,
    );
    await http()
      .post('/auth/password-reset/complete')
      .send({ code, newPassword, revokeOtherSessions: false })
      .expect(200);
  }

  const openSelfLocks = (userId: string) =>
    getCtx()
      .dataSource.getRepository(AccountRestriction)
      .findBy({ userId, reason: 'self_lock', liftedAt: IsNull() });

  const auditFor = (userId: string, action: string) =>
    getCtx().dataSource.getRepository(AuditEvent).findBy({
      subjectType: 'user',
      subjectId: userId,
      action,
    });

  return {
    http,
    bearer,
    seedSignedInOwner,
    linkTokenFor,
    lockInApp,
    lockByLink,
    stepUpCode,
    resetPassword,
    openSelfLocks,
    auditFor,
  };
}
