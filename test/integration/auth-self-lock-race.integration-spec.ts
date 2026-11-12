import { InitiatorAccountFrozenException } from '../../src/modules/withdrawals/internal/errors';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  seedBankAccount,
} from './support/withdrawals-test-context';
import { IsNull } from 'typeorm';
import { errorOf } from './support/api-response';
import {
  createAuthTestHelpers,
  extractSixDigitCode,
} from './support/auth-test-helpers';
import { createAccountControlsHelpers } from './support/account-controls-helpers';
import {
  NEW_PASSWORD,
  createSelfLockHelpers,
} from './support/self-lock-helpers';
import { holdUserLock, trackSettled, waitBriefly } from './support/user-lock';

jest.setTimeout(180_000);

describe('Self-lock racing a withdrawal', () => {
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

  async function seedOwnerWithBank() {
    const owner = await s.seedSignedInOwner();
    seq += 1;
    const bank = await seedBankAccount(ctx, {
      userId: owner.userId,
      accountNumber: `0099${String(100_000 + seq).padStart(6, '0')}`,
    });
    const wallet = await ctx.accountRepo.findOneByOrFail({
      userId: owner.userId,
      role: 'user_wallet',
    });
    return { ...owner, bankAccountId: bank.id, walletId: wallet.id };
  }

  it('refuses a withdrawal that was waiting on the user lock when the lock committed first', async () => {
    const owner = await seedOwnerWithBank();
    const before = (
      await ctx.accountRepo.findOneByOrFail({ id: owner.walletId })
    ).balance;
    const held = await holdUserLock(ctx.dataSource, owner.userId);

    const lock = trackSettled(s.lockInApp(owner.accessToken).then((r) => r));
    await waitBriefly();
    const withdrawal = trackSettled(
      h.withdraw(owner.userId, owner.bankAccountId, 500_000).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    await waitBriefly();
    expect(lock.isSettled()).toBe(false);
    expect(withdrawal.isSettled()).toBe(false);

    await held.release();

    expect((await lock.promise).status).toBe(200);
    expect(await withdrawal.promise).toBeInstanceOf(
      InitiatorAccountFrozenException,
    );
    const after = await ctx.accountRepo.findOneByOrFail({ id: owner.walletId });
    expect(after.balance).toBe(before);
  });

  it('lets a withdrawal that committed first stand, then refuses the next', async () => {
    const owner = await seedOwnerWithBank();
    const held = await holdUserLock(ctx.dataSource, owner.userId);

    const withdrawal = trackSettled(
      h.withdraw(owner.userId, owner.bankAccountId, 500_000),
    );
    await waitBriefly();
    const lock = trackSettled(s.lockInApp(owner.accessToken).then((r) => r));
    await waitBriefly();
    expect(withdrawal.isSettled()).toBe(false);
    expect(lock.isSettled()).toBe(false);

    await held.release();

    await expect(withdrawal.promise).resolves.toBeDefined();
    expect((await lock.promise).status).toBe(200);
    await expect(
      h.withdraw(owner.userId, owner.bankAccountId, 500_000),
    ).rejects.toBeInstanceOf(InitiatorAccountFrozenException);
    expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
  });

  it('does not lock itself against concurrent lock requests', async () => {
    const owner = await seedOwnerWithBank();

    const results = await Promise.all([
      s.lockByLink(s.linkTokenFor(owner.userId)),
      s.lockInApp(owner.accessToken),
      s.lockByLink(s.linkTokenFor(owner.userId)),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
  });
  it('refuses a password reset that was waiting on the user lock when a lock voided its code', async () => {
    const owner = await s.seedSignedInOwner();
    await s
      .http()
      .post('/auth/password-reset/request')
      .send({ email: owner.email })
      .expect(200);
    const code = extractSixDigitCode(
      (await auth.waitForPasswordResetEmail(owner.email)).text,
    );
    const held = await holdUserLock(ctx.dataSource, owner.userId);

    const reset = trackSettled(
      s
        .http()
        .post('/auth/password-reset/complete')
        .send({
          code,
          newPassword: NEW_PASSWORD,
          revokeOtherSessions: false,
        })
        .then((r) => r),
    );
    await waitBriefly();
    expect(reset.isSettled()).toBe(false);
    await ctx.verificationCodeRepo.update(
      { userId: owner.userId, usedAt: IsNull() },
      { usedAt: new Date() },
    );
    await held.release();

    expect(errorOf(await reset.promise).code).toBe('VERIFICATION_CODE_INVALID');
    const credential = await ctx.credentialRepo.findOneByOrFail({
      userId: owner.userId,
    });
    expect(credential.passwordResetAt).toBeNull();
  });
});
