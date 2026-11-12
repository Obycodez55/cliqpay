import * as request from 'supertest';
import { IsNull } from 'typeorm';
import { RateLimitModule } from '../../src/rate-limit/rate-limit.module';
import { AccountRestriction } from '../../src/modules/users/entities/account-restriction.entity';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
} from './support/withdrawals-test-context';
import {
  SECURITY_ALERT_SUBJECT,
  createAuthTestHelpers,
  extractSixDigitCode,
  stepUpCodeSubject,
  waitFor,
} from './support/auth-test-helpers';
import { dataOf } from './support/api-response';

jest.setTimeout(120_000);

describe('Self-lock link in security alerts', () => {
  let ctx: WithdrawalsTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext({}, [RateLimitModule]);
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  const lockWith = (token: string) =>
    request(ctx.app.getHttpServer())
      .post('/auth/self-lock/token')
      .send({ token });

  it('puts a working lock link in the alert a real security event sends', async () => {
    const { user } = await helpers.registerUser({
      email: 'self-lock-link@example.com',
      username: 'self_lock_link',
      phone: '+2348077700001',
    });
    await helpers.agePastResendCooldown(user.id, 'email_verification');
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    const step = await request(ctx.app.getHttpServer())
      .post('/auth/change-email/step-up')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({})
      .expect(200);
    const code = extractSixDigitCode(
      helpers.latestEmailWithSubject(
        stepUpCodeSubject('change your email address'),
      ).text,
    );
    await request(ctx.app.getHttpServer())
      .post('/auth/change-email')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({
        newEmail: 'self-lock-link-new@example.com',
        challengeId: dataOf<{ challengeId: string }>(step).challengeId,
        code,
      })
      .expect(204);

    await waitFor(() =>
      ctx.emailAdapter.sent.some(
        (m) => m.to === user.email && m.subject === SECURITY_ALERT_SUBJECT,
      ),
    );
    const alert = helpers.latestEmailWithSubject(SECURITY_ALERT_SUBJECT);
    const link = alert.text.match(
      /https:\/\/app\.cliqpay\.test\/lock\?token=(\S+)/,
    );
    expect(link).not.toBeNull();

    await lockWith(link![1]).expect(200);

    expect(
      await ctx.dataSource.getRepository(AccountRestriction).countBy({
        userId: user.id,
        reason: 'self_lock',
        liftedAt: IsNull(),
      }),
    ).toBe(1);
  });

  it('rate-limits the public lock endpoint', async () => {
    for (let i = 0; i < 4; i++) {
      await lockWith('not-a-token').expect(400);
    }
    await lockWith('not-a-token').expect(429);
  });
});
