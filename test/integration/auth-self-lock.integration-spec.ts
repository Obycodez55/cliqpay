import { randomUUID } from 'crypto';
import { SenderAccountFrozenException } from '../../src/modules/transfers/internal/errors';
import { InitiatorAccountFrozenException } from '../../src/modules/withdrawals/internal/errors';
import { UserLimit } from '../../src/modules/kyc/entities/user-limit.entity';
import { errorOf } from './support/api-response';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  seedBankAccount,
} from './support/withdrawals-test-context';
import { createAuthTestHelpers, waitFor } from './support/auth-test-helpers';
import { createAccountControlsHelpers } from './support/account-controls-helpers';
import { createSelfLockHelpers } from './support/self-lock-helpers';

jest.setTimeout(180_000);

const LOCKED_SUBJECT = 'Your Cliqpay account is locked';

describe('Self-lock: locking an account', () => {
  let ctx: WithdrawalsTestContext;
  let auth: ReturnType<typeof createAuthTestHelpers>;
  const h = createAccountControlsHelpers(() => ctx);
  let s: ReturnType<typeof createSelfLockHelpers>;
  let bankSeq = 0;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
    auth = createAuthTestHelpers(ctx);
    s = createSelfLockHelpers(() => ctx, auth, h);
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  const confirmations = (email: string) =>
    ctx.emailAdapter.sent.filter(
      (m) => m.to === email && m.subject === LOCKED_SUBJECT,
    );

  it('adds an outbound self_lock restriction that blocks sending and withdrawing', async () => {
    const owner = await s.seedSignedInOwner();
    bankSeq += 1;
    const bankAccount = await seedBankAccount(ctx, {
      userId: owner.userId,
      accountNumber: `0088${String(100_000 + bankSeq).padStart(6, '0')}`,
    });
    const recipient = await h.seedUser('lock-to', { balanceMinor: 0n });

    await s.lockInApp(owner.accessToken).expect(200);

    const [restriction] = await s.openSelfLocks(owner.userId);
    expect(restriction.scope).toBe('outbound');
    await expect(
      h.transfer(owner.userId, recipient.userId, 20_000),
    ).rejects.toBeInstanceOf(SenderAccountFrozenException);
    await expect(
      h.withdraw(owner.userId, bankAccount.id, 20_000),
    ).rejects.toBeInstanceOf(InitiatorAccountFrozenException);
  });

  it('revokes every session, trusted device and device key', async () => {
    const owner = await s.seedSignedInOwner();
    expect(
      await ctx.sessionRepo.countBy({ userId: owner.userId, status: 'active' }),
    ).toBeGreaterThan(0);

    await s.lockInApp(owner.accessToken).expect(200);

    expect(
      await ctx.sessionRepo.countBy({ userId: owner.userId, status: 'active' }),
    ).toBe(0);
    const devices = await ctx.trustedDeviceRepo.findBy({
      userId: owner.userId,
    });
    expect(devices.length).toBeGreaterThan(0);
    expect(devices.every((d) => d.revokedAt !== null)).toBe(true);

    const previous = ctx.config.device.keyRequired;
    ctx.config.device.keyRequired = true;
    try {
      await expect(
        ctx.deviceBindingService.verifySignedAction({
          userId: owner.userId,
          deviceId: devices[0].deviceId,
          action: 'transfer.send',
          reference: 'r',
          amount: '1',
          target: 't',
          timestamp: String(Math.floor(Date.now() / 1000)),
          signature: 'AAAA',
        }),
      ).rejects.toMatchObject({ code: 'DEVICE_KEY_NOT_REGISTERED' });
    } finally {
      ctx.config.device.keyRequired = previous;
    }
  });

  it('cancels a pending limit raise', async () => {
    const owner = await s.seedSignedInOwner();
    await ctx.kycService.lowerDailyOutflowLimit(owner.userId, 1_000_000);
    await ctx.kycService.requestDailyOutflowLimitRaise(owner.userId, 3_000_000);
    const limits = ctx.dataSource.getRepository(UserLimit);
    expect(
      (await limits.findOneByOrFail({ userId: owner.userId }))
        .pendingDailyOutflowLimitMinor,
    ).not.toBeNull();

    await s.lockInApp(owner.accessToken).expect(200);

    const after = await limits.findOneByOrFail({ userId: owner.userId });
    expect(after.pendingDailyOutflowLimitMinor).toBeNull();
    expect(after.pendingEffectiveAt).toBeNull();
    expect(
      await s.auditFor(owner.userId, 'daily_limit_raise_cancelled'),
    ).toHaveLength(1);
  });

  it('drops a pending email and phone change started before the lock', async () => {
    const owner = await s.seedSignedInOwner();
    await ctx.usersService.setPendingEmail(
      owner.userId,
      'attacker@example.com',
    );
    await ctx.usersService.setPendingPhone(owner.userId, '+2348000000000');

    await s.lockInApp(owner.accessToken).expect(200);

    const user = await ctx.userRepo.findOneByOrFail({ id: owner.userId });
    expect(user.pendingEmail).toBeNull();
    expect(user.pendingPhone).toBeNull();
  });

  it('audits the lock with who, how and what it cut off', async () => {
    const owner = await s.seedSignedInOwner();

    await s.lockInApp(owner.accessToken).expect(200);

    const [event] = await s.auditFor(owner.userId, 'account_self_locked');
    expect(event.actorType).toBe('user');
    expect(event.actorId).toBe(owner.userId);
    expect(event.metadata).toMatchObject({
      method: 'app',
      alreadyLocked: false,
      devicesRevoked: 1,
    });
    expect(await s.auditFor(owner.userId, 'restriction_added')).toHaveLength(1);
  });

  it('confirms the lock by email', async () => {
    const owner = await s.seedSignedInOwner();

    await s.lockInApp(owner.accessToken).expect(200);

    await waitFor(() => confirmations(owner.email).length > 0);
  });

  it('requires a session for the in-app lock', async () => {
    await s.http().post('/auth/self-lock').expect(401);
  });

  it('leaves other users alone', async () => {
    const owner = await s.seedSignedInOwner();
    const other = await s.seedSignedInOwner();

    await s.lockInApp(owner.accessToken).expect(200);

    expect(await s.openSelfLocks(other.userId)).toHaveLength(0);
    expect(
      await ctx.sessionRepo.countBy({ userId: other.userId, status: 'active' }),
    ).toBeGreaterThan(0);
  });

  describe('with the link from a security alert', () => {
    it('locks without a session', async () => {
      const owner = await s.seedSignedInOwner();

      const res = await s.lockByLink(s.linkTokenFor(owner.userId)).expect(200);

      expect(res.body).toMatchObject({ data: { locked: true } });
      expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
      expect(
        await ctx.sessionRepo.countBy({
          userId: owner.userId,
          status: 'active',
        }),
      ).toBe(0);
      const [event] = await s.auditFor(owner.userId, 'account_self_locked');
      expect(event.metadata).toMatchObject({ method: 'link' });
    });

    it('is harmless to use twice: one restriction, one confirmation', async () => {
      const owner = await s.seedSignedInOwner();
      const token = s.linkTokenFor(owner.userId);

      await s.lockByLink(token).expect(200);
      await s.lockByLink(token).expect(200);
      await s.lockInApp(owner.accessToken).expect(200);

      expect(await s.openSelfLocks(owner.userId)).toHaveLength(1);
      await waitFor(() => confirmations(owner.email).length > 0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(confirmations(owner.email)).toHaveLength(1);
      expect(
        await s.auditFor(owner.userId, 'account_self_locked'),
      ).toHaveLength(3);
    });

    it('rejects an expired token and leaves the account alone', async () => {
      const owner = await s.seedSignedInOwner();
      const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      const res = await s
        .lockByLink(s.linkTokenFor(owner.userId, longAgo))
        .expect(400);

      expect(errorOf(res).code).toBe('SELF_LOCK_TOKEN_INVALID');
      expect(await s.openSelfLocks(owner.userId)).toHaveLength(0);
    });

    it('rejects a token whose user was swapped', async () => {
      const owner = await s.seedSignedInOwner();
      const victim = await s.seedSignedInOwner();
      const [, expiry, signature] = s.linkTokenFor(owner.userId).split('.');
      const swapped = [
        Buffer.from(victim.userId).toString('base64url'),
        expiry,
        signature,
      ].join('.');

      const res = await s.lockByLink(swapped).expect(400);

      expect(errorOf(res).code).toBe('SELF_LOCK_TOKEN_INVALID');
      expect(await s.openSelfLocks(victim.userId)).toHaveLength(0);
      expect(await s.openSelfLocks(owner.userId)).toHaveLength(0);
    });

    it('rejects garbage and a validly signed token for a user that does not exist', async () => {
      await s.lockByLink('not-a-token').expect(400);
      const res = await s.lockByLink(s.linkTokenFor(randomUUID())).expect(400);
      expect(errorOf(res).code).toBe('SELF_LOCK_TOKEN_INVALID');
    });
  });
});
