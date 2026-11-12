import { randomUUID } from 'crypto';
import * as request from 'supertest';
import {
  AuthTestContext,
  createAuthTestContext,
  destroyAuthTestContext,
} from './support/auth-test-context';
import {
  createAuthTestHelpers,
  extractSixDigitCode,
  stepUpCodeSubject,
} from './support/auth-test-helpers';
import { dataOf } from './support/api-response';
import { describeSignedAction } from './support/signed-actions';

jest.setTimeout(120_000);

describe('device signatures on the transaction PIN', () => {
  let ctx: AuthTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createAuthTestContext();
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyAuthTestContext(ctx);
  });

  async function userWithPin() {
    seq += 1;
    const { user } = await helpers.registerUser({
      email: `pin-sig-${seq}@example.com`,
      username: `pin_sig_${seq}`,
      phone: `+2348077${String(100_000 + seq).padStart(6, '0')}`,
    });
    const { tokens } = await helpers.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    const stepUp = async (path: string, purpose: string) => {
      const res = await request(ctx.app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({})
        .expect(200);
      return {
        challengeId: dataOf<{ challengeId: string }>(res).challengeId,
        code: extractSixDigitCode(
          helpers.latestEmailWithSubject(
            stepUpCodeSubject(`${purpose} your transaction PIN`),
          ).text,
        ),
      };
    };
    const set = await stepUp('/auth/transaction-pin/set/step-up', 'set');
    await request(ctx.app.getHttpServer())
      .post('/auth/transaction-pin/set')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ pin: '4837', ...set })
      .expect(204);
    return { user, tokens, stepUp };
  }

  const pinHash = async (userId: string) =>
    (await ctx.credentialRepo.findOneByOrFail({ userId })).transactionPinHash;

  for (const action of ['change', 'reset'] as const) {
    describeSignedAction(
      `POST /auth/transaction-pin/${action}`,
      () => ctx,
      { tamper: ['reference'], replays: false },
      async () => {
        const { user, tokens, stepUp } = await userWithPin();
        const before = await pinHash(user.id);
        const { challengeId, code } = await stepUp(
          `/auth/transaction-pin/${action}/step-up`,
          action,
        );
        const body =
          action === 'change'
            ? { currentPin: '4837', newPin: '9182', challengeId, code }
            : { newPin: '9182', challengeId, code };
        const post =
          (payload: Record<string, unknown>) =>
          (headers: Record<string, string>) =>
            request(ctx.app.getHttpServer())
              .post(`/auth/transaction-pin/${action}`)
              .set('Authorization', `Bearer ${tokens.accessToken}`)
              .set(headers)
              .send(payload);
        return {
          userId: user.id,
          signs: {
            action: `pin.${action}`,
            reference: challengeId,
            amount: '',
            target: user.id,
          },
          send: post(body),
          tampered: {
            reference: post({ ...body, challengeId: randomUUID() }),
          },
          expectApplied: async () => {
            expect(await pinHash(user.id)).not.toBe(before);
          },
          expectUntouched: async () => {
            expect(await pinHash(user.id)).toBe(before);
          },
        };
      },
    );
  }
});
