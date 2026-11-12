import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { UserLimit } from '../../src/modules/kyc/entities/user-limit.entity';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
} from './support/withdrawals-test-context';
import {
  createAuthTestHelpers,
  extractSixDigitCode,
  stepUpCodeSubject,
} from './support/auth-test-helpers';
import { createAccountControlsHelpers } from './support/account-controls-helpers';
import { dataOf } from './support/api-response';
import { describeSignedAction } from './support/signed-actions';

jest.setTimeout(180_000);

const PIN = '4821';

describe('device signatures on raising the daily limit', () => {
  let ctx: WithdrawalsTestContext;
  let auth: ReturnType<typeof createAuthTestHelpers>;
  const h = createAccountControlsHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
    auth = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  const pendingOf = async (userId: string) =>
    (await ctx.dataSource.getRepository(UserLimit).findOneBy({ userId }))
      ?.pendingDailyOutflowLimitMinor ?? null;

  describeSignedAction(
    'POST /wallet/limits/daily/raise',
    () => ctx,
    { tamper: ['reference', 'amount'], replays: false },
    async () => {
      const owner = await h.seedOwner(auth, PIN);
      const res = await h
        .authed(owner.userId, 'post', '/wallet/limits/daily/raise/step-up')
        .send({})
        .expect(201);
      const challengeId = dataOf<{ challengeId: string }>(res).challengeId;
      const code = extractSixDigitCode(
        auth.latestEmailWithSubject(stepUpCodeSubject('raise your daily limit'))
          .text,
      );
      await h.authed(owner.userId, 'post', '/wallet/limits/daily/lower').send({
        amount: 1_000_000,
        pin: PIN,
      });
      const body = { amount: 3_000_000, pin: PIN, challengeId, code };
      const post =
        (payload: Record<string, unknown>) =>
        (headers: Record<string, string>) =>
          request(ctx.app.getHttpServer())
            .post('/wallet/limits/daily/raise')
            .set('Authorization', `Bearer ${h.token(owner.userId)}`)
            .set(headers)
            .send(payload);
      return {
        userId: owner.userId,
        signs: {
          action: 'limit.raise',
          reference: challengeId,
          amount: '3000000',
          target: '',
        },
        send: post(body),
        tampered: {
          reference: post({ ...body, challengeId: randomUUID() }),
          amount: post({ ...body, amount: 4_000_000 }),
        },
        expectApplied: async () => {
          expect(await pendingOf(owner.userId)).toBe(3_000_000n);
        },
        expectUntouched: async () => {
          expect(await pendingOf(owner.userId)).toBeNull();
        },
      };
    },
  );
});
