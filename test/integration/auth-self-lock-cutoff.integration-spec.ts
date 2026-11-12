import { randomUUID } from 'crypto';
import { PushToken } from '../../src/modules/notifications/entities/push-token.entity';
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
import { TEST_INTERNAL_API_SECRET } from './support/test-app-config';

jest.setTimeout(180_000);

describe('Self-lock: what a lock cuts off and which lock links still work', () => {
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

  const pushTokens = () => ctx.dataSource.getRepository(PushToken);
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  async function unlockAfterReset(email: string) {
    await s.resetPassword(email);
    const { tokens } = await auth.loginAndVerify(email, NEW_PASSWORD);
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
  }

  it('deletes the owner’s push tokens once the lock is handled', async () => {
    const owner = await s.seedSignedInOwner();
    await pushTokens().insert([
      { userId: owner.userId, platform: 'android', token: randomUUID() },
      { userId: owner.userId, platform: 'ios', token: randomUUID() },
    ]);
    const other = await s.seedSignedInOwner();
    await pushTokens().insert({
      userId: other.userId,
      platform: 'ios',
      token: randomUUID(),
    });

    await s.lockInApp(owner.accessToken).expect(200);

    const deadline = Date.now() + 5000;
    while (
      (await pushTokens().countBy({ userId: owner.userId })) > 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await pushTokens().countBy({ userId: owner.userId })).toBe(0);
    expect(await pushTokens().countBy({ userId: other.userId })).toBe(1);
  });

  it('refuses a lock link issued before the latest unlock, accepts one issued after', async () => {
    const owner = await s.seedSignedInOwner();
    const oldLink = s.linkTokenFor(owner.userId, minutesAgo(5));
    await s.lockInApp(owner.accessToken).expect(200);
    await unlockAfterReset(owner.email);
    expect(await s.openSelfLocks(owner.userId)).toHaveLength(0);

    await s.lockByLink(oldLink).expect(400);
    expect(await s.openSelfLocks(owner.userId)).toHaveLength(0);

    await s.lockByLink(s.linkTokenFor(owner.userId)).expect(200);
    expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
  });

  it('refuses a lock link issued before an email recovery', async () => {
    const owner = await s.seedSignedInOwner();
    const oldLink = s.linkTokenFor(owner.userId, minutesAgo(5));
    seq += 1;

    await s
      .http()
      .post(`/internal/risk/users/${owner.userId}/recover-email`)
      .set({
        'X-Internal-Secret': TEST_INTERNAL_API_SECRET,
        'X-Reviewer-Id': 'reviewer-12',
      })
      .send({ newEmail: `cutoff-recovered-${seq}@example.com` })
      .expect(204);

    await s.lockByLink(oldLink).expect(400);
    expect(await s.openSelfLocks(owner.userId)).toHaveLength(0);
    await s.lockByLink(s.linkTokenFor(owner.userId)).expect(200);
  });
});
