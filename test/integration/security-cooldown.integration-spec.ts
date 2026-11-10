import { randomUUID } from 'crypto';
import { SecurityCooldownLimitException } from '../../src/modules/kyc/internal/errors';
import { NewAccountInflowLimitException } from '../../src/modules/kyc/internal/errors';
import { MoneyRequestsService } from '../../src/modules/transfers/money-requests.service';
import { AuditEvent } from '../../src/shared/audit/entities/audit-event.entity';
import { VerificationCodeService } from '../../src/modules/auth/verification-code.service';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  seedBankAccount,
} from './support/withdrawals-test-context';
import {
  HOUR_MS,
  createAccountControlsHelpers,
  money,
} from './support/account-controls-helpers';

jest.setTimeout(180_000);

const CAP = 2_000_000;

describe('Security cooldown', () => {
  let ctx: WithdrawalsTestContext;
  const h = createAccountControlsHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  async function errorOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => null,
      (e: unknown) => e,
    );
  }

  describe('the outflow cap', () => {
    it('does not limit anything before a security change', async () => {
      const sender = await h.seedUser('free');
      const recipient = await h.seedUser('free-to', { balanceMinor: 0n });

      await expect(
        h.transfer(sender.userId, recipient.userId, 3_000_000),
      ).resolves.toBeDefined();
    });

    it('caps P2P sends and withdrawals together over the last 24 hours', async () => {
      const sender = await h.seedUser('capped');
      const recipient = await h.seedUser('capped-to', { balanceMinor: 0n });
      await h.startCooldown(sender.userId);

      await h.transfer(sender.userId, recipient.userId, 1_200_000);
      await h.withdraw(sender.userId, sender.bankAccountId, 500_000);

      const error = await errorOf(
        h.transfer(sender.userId, recipient.userId, 400_000),
      );
      expect(error).toBeInstanceOf(SecurityCooldownLimitException);
      const { cooldownEndsAt, limit, remaining } = (
        error as SecurityCooldownLimitException
      ).details;
      expect(new Date(cooldownEndsAt).getTime()).toBeGreaterThan(
        Date.now() + 23 * HOUR_MS,
      );
      expect(limit).toEqual(money(CAP));
      expect(remaining).toEqual(money(300_000));
      expect((error as SecurityCooldownLimitException).code).toBe(
        'SECURITY_COOLDOWN_LIMIT',
      );

      await expect(
        h.withdraw(sender.userId, sender.bankAccountId, 300_000),
      ).resolves.toBeDefined();
      await expect(
        h.withdraw(sender.userId, sender.bankAccountId, 10_000),
      ).rejects.toBeInstanceOf(SecurityCooldownLimitException);
    });

    it('does not reset the rolling sum when the cooldown is triggered again', async () => {
      const sender = await h.seedUser('retrigger');
      const recipient = await h.seedUser('retrigger-to', { balanceMinor: 0n });
      await h.startCooldown(sender.userId);
      const first = await h.cooldownOf(sender.userId);
      await h.transfer(sender.userId, recipient.userId, 1_900_000);

      await h.startCooldown(sender.userId);

      const second = await h.cooldownOf(sender.userId);
      expect(second.startedAt).toEqual(first.startedAt);
      expect(second.until!.getTime()).toBeGreaterThanOrEqual(
        first.until!.getTime(),
      );
      const error = await errorOf(
        h.transfer(sender.userId, recipient.userId, 200_000),
      );
      expect(error).toBeInstanceOf(SecurityCooldownLimitException);
      expect(
        (error as SecurityCooldownLimitException).details.remaining,
      ).toEqual(money(100_000));
    });

    it('frees allowance as earlier sends leave the 24-hour window', async () => {
      const sender = await h.seedUser('rolling');
      const recipient = await h.seedUser('rolling-to', { balanceMinor: 0n });
      await h.startCooldown(sender.userId);
      await h.transfer(sender.userId, recipient.userId, 2_000_000);
      await expect(
        h.transfer(sender.userId, recipient.userId, 10_000),
      ).rejects.toBeInstanceOf(SecurityCooldownLimitException);

      await h.ageDebits(sender.userId, 25);

      await expect(
        h.transfer(sender.userId, recipient.userId, 2_000_000),
      ).resolves.toBeDefined();
    });

    it('stops applying once the cooldown has ended', async () => {
      const sender = await h.seedUser('ended');
      const recipient = await h.seedUser('ended-to', { balanceMinor: 0n });
      await h.startCooldown(sender.userId);
      await h.setUser(sender.userId, {
        securityCooldownUntil: new Date(Date.now() - 1000),
      });

      await expect(
        h.transfer(sender.userId, recipient.userId, 3_000_000),
      ).resolves.toBeDefined();
    });

    it('lets the tier limit speak first when it is the tighter one', async () => {
      const sender = await h.seedUser('tier-first');
      const recipient = await h.seedUser('tier-first-to', {
        balanceMinor: 0n,
      });
      await h.startCooldown(sender.userId);

      const error = await errorOf(
        h.transfer(sender.userId, recipient.userId, 9_000_000),
      );

      expect((error as { code: string }).code).toBe('DAILY_LIMIT_EXCEEDED');
    });
  });

  describe('what starts it', () => {
    it('is started, and audited, by completing a password reset', async () => {
      const user = await h.seedUser('reset', { balanceMinor: 0n });
      const { token } = await ctx.app
        .get(VerificationCodeService, { strict: false })
        .issue(user.userId, 'password_reset', 10 * 60 * 1000);

      await ctx.authService.completePasswordReset(
        token,
        'a-new-strong-unique-passphrase',
        false,
      );

      const cooldown = await h.cooldownOf(user.userId);
      expect(cooldown.until!.getTime()).toBeGreaterThan(
        Date.now() + 23 * HOUR_MS,
      );
      const events = await ctx.dataSource.getRepository(AuditEvent).findBy({
        subjectId: user.userId,
        action: 'security_cooldown_started',
      });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({ trigger: 'password_reset' });
    });
  });

  describe('new accounts: cumulative inflow cap', () => {
    const newcomer = async (prefix: string) => {
      const user = await h.seedUser(prefix, { balanceMinor: 0n });
      await h.setUser(user.userId, { tier1ReachedAt: new Date() });
      return user;
    };

    it('counts what was received, not the balance: receive 15k, send 15k, then 10k more is refused', async () => {
      const rich = await h.seedUser('rich');
      const fresh = await newcomer('fresh-cum');
      const elsewhere = await h.seedUser('elsewhere', { balanceMinor: 0n });
      await h.transfer(rich.userId, fresh.userId, 1_500_000);
      await h.transfer(fresh.userId, elsewhere.userId, 1_500_000);

      const error = await errorOf(
        h.transfer(rich.userId, fresh.userId, 1_000_000),
      );
      expect((error as { code: string }).code).toBe(
        'RECIPIENT_UNABLE_TO_RECEIVE',
      );

      await expect(
        h.transfer(rich.userId, fresh.userId, 500_000),
      ).resolves.toBeDefined();
    });

    it('refuses initiating a funding over the remaining allowance with NEW_ACCOUNT_INFLOW_LIMIT, counting fundings in flight', async () => {
      const fresh = await newcomer('fresh-fund');
      await ctx.paymentsService.fundWallet(fresh.userId, {
        amount: 1_500_000,
        reference: `cliqpay-ctl-fund-${randomUUID()}`,
      });

      const error = await errorOf(
        ctx.paymentsService.fundWallet(fresh.userId, {
          amount: 600_000,
          reference: `cliqpay-ctl-fund-${randomUUID()}`,
        }),
      );

      expect(error).toBeInstanceOf(NewAccountInflowLimitException);
      const { details, code } = error as NewAccountInflowLimitException;
      expect(code).toBe('NEW_ACCOUNT_INFLOW_LIMIT');
      expect(details.remaining).toEqual(money(500_000));
      expect(details.limit).toEqual(money(CAP));
      expect(new Date(details.windowEndsAt).getTime()).toBeGreaterThan(
        Date.now() + 23 * HOUR_MS,
      );
    });

    it('refuses creating a money request over the remaining allowance', async () => {
      const rich = await h.seedUser('rich-req');
      const fresh = await newcomer('fresh-req');
      await h.transfer(rich.userId, fresh.userId, 1_800_000);
      const requests = ctx.app.get(MoneyRequestsService, { strict: false });

      await expect(
        requests.createRequest(fresh.userId, {
          payerUserId: rich.userId,
          amount: 300_000,
        }),
      ).rejects.toBeInstanceOf(NewAccountInflowLimitException);
      await expect(
        requests.createRequest(fresh.userId, {
          payerUserId: rich.userId,
          amount: 200_000,
        }),
      ).resolves.toBeDefined();
    });

    it('does not count money coming back to the user as inflow', async () => {
      const fresh = await newcomer('fresh-back');
      const rich = await h.seedUser('rich-back');
      await h.transfer(rich.userId, fresh.userId, 1_900_000);
      const bank = await seedBankAccount(ctx, {
        userId: fresh.userId,
        accountNumber: '0055000001',
      });
      const withdrawal = await h.withdraw(fresh.userId, bank.id, 1_000_000);
      await ctx.ledgerService.reverseWithdrawal({
        reference: withdrawal.reference,
        reason: 'test',
      });

      await expect(
        h.transfer(rich.userId, fresh.userId, 100_000),
      ).resolves.toBeDefined();
    });

    it('stops applying 24 hours after reaching Tier 1', async () => {
      const rich = await h.seedUser('rich-later');
      const fresh = await newcomer('fresh-later');
      await h.transfer(rich.userId, fresh.userId, 2_000_000);
      await expect(
        h.transfer(rich.userId, fresh.userId, 10_000),
      ).rejects.toMatchObject({ code: 'RECIPIENT_UNABLE_TO_RECEIVE' });

      await h.setUser(fresh.userId, {
        tier1ReachedAt: new Date(Date.now() - 25 * HOUR_MS),
      });

      await expect(
        h.transfer(rich.userId, fresh.userId, 2_500_000),
      ).resolves.toBeDefined();
    });
  });
});
