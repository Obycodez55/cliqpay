import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { KycTier } from '../../src/modules/users/users.service';
import {
  BalanceCapExceededException,
  DailyLimitExceededException,
} from '../../src/modules/kyc/internal/errors';
import { WalletLimitsResponseDto } from '../../src/modules/payments/dto/wallet-limits-response.dto';
import { TEST_JWT_SECRET } from './support/test-app-config';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  fundWallet,
  seedBankAccount,
  seedWithdrawalUser,
} from './support/withdrawals-test-context';

jest.setTimeout(180_000);

const TIER1_LIMIT = 5_000_000;
const TIER1_CAP = 30_000_000;

const money = (amount: number | string) => ({
  amount: String(amount),
  currency: 'NGN',
});

describe('GET /wallet/limits', () => {
  let ctx: WithdrawalsTestContext;
  let jwtService: JwtService;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
    jwtService = new JwtService({ secret: TEST_JWT_SECRET });
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  async function seedUser(tier: KycTier = 'tier1', balanceMinor = 0n) {
    seq += 1;
    const n = seq;
    const { userId, walletId } = await seedWithdrawalUser(ctx, {
      email: `limits-${n}@example.com`,
      phone: `+2348088${String(100_000 + n).padStart(6, '0')}`,
      username: `limits_user_${n}`,
      kycTier: tier,
    });
    if (balanceMinor > 0n) {
      await fundWallet(ctx, {
        reference: `cliqpay-limits-fund-${randomUUID()}`,
        walletId,
        netAmountMinor: balanceMinor,
      });
    }
    const bankAccount = await seedBankAccount(ctx, {
      userId,
      accountNumber: `0088${String(100_000 + n).padStart(6, '0')}`,
    });
    return { userId, bankAccountId: bankAccount.id };
  }

  function getLimits(userId: string) {
    return request(ctx.app.getHttpServer())
      .get('/wallet/limits')
      .set(
        'Authorization',
        `Bearer ${jwtService.sign({ sub: userId, sid: 'test-session' })}`,
      );
  }

  async function limits(userId: string) {
    const res = await getLimits(userId).expect(200);
    return res.body as WalletLimitsResponseDto;
  }

  function transfer(senderId: string, recipientUserId: string, amount: number) {
    return ctx.transfersService.sendMoney(senderId, {
      recipientUserId,
      amount,
      reference: `cliqpay-limits-xfer-${randomUUID()}`,
      pin: '1234',
    });
  }

  function withdraw(
    userId: string,
    bankAccountId: string,
    amount: number,
    reference = `cliqpay-limits-wd-${randomUUID()}`,
  ) {
    return ctx.withdrawalsService.initiateWithdrawal(userId, {
      bankAccountId,
      amount,
      reference,
      pin: '1234',
    });
  }

  function fund(userId: string, amount: number) {
    return ctx.paymentsService.fundWallet(userId, {
      amount,
      reference: `cliqpay-limits-fund-${randomUUID()}`,
    });
  }

  it('rejects an unauthenticated request', async () => {
    await request(ctx.app.getHttpServer()).get('/wallet/limits').expect(401);
  });

  it('reports a fresh tier 1 user’s full allowance and headroom, resetting at the next Lagos midnight', async () => {
    const user = await seedUser();

    const { resetsAt: resetsAtIso, ...body } = await limits(user.userId);

    expect(body).toEqual({
      tier: 'tier1',
      dailyLimit: money(TIER1_LIMIT),
      debitedToday: money(0),
      remainingToday: money(TIER1_LIMIT),
      balanceCap: money(TIER1_CAP),
      balance: money(0),
      pendingFunding: money(0),
      headroom: money(TIER1_CAP),
    });
    const resetsAt = new Date(resetsAtIso);
    expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
    expect(resetsAt.getTime() - Date.now()).toBeLessThanOrEqual(
      24 * 60 * 60 * 1000,
    );
    expect(resetsAt.getUTCHours()).toBe(23);
    expect(resetsAt.getUTCMinutes()).toBe(0);
  });

  it('counts both a transfer and a withdrawal as debited today, and a reversed withdrawal frees its share', async () => {
    const sender = await seedUser('tier1', 20_000_000n);
    const recipient = await seedUser('tier1');
    const reference = `cliqpay-limits-wd-${randomUUID()}`;

    await transfer(sender.userId, recipient.userId, 1_000_000);
    await withdraw(sender.userId, sender.bankAccountId, 500_000, reference);

    let body = await limits(sender.userId);
    expect(body.debitedToday).toEqual(money(1_500_000));
    expect(body.remainingToday).toEqual(money(TIER1_LIMIT - 1_500_000));

    await ctx.ledgerService.reverseWithdrawal({
      reference,
      reason: 'Beneficiary account closed',
    });

    body = await limits(sender.userId);
    expect(body.debitedToday).toEqual(money(1_000_000));
    expect(body.remainingToday).toEqual(money(TIER1_LIMIT - 1_000_000));
  });

  it('reduces the headroom by a pending funding and shows it', async () => {
    const user = await seedUser();
    await fund(user.userId, 5_000_000);

    const body = await limits(user.userId);

    expect(body.pendingFunding).toEqual(money(5_000_000));
    expect(body.headroom).toEqual(money(TIER1_CAP - 5_000_000));
  });

  it('reports zero headroom, not a negative one, for a wallet already over its cap', async () => {
    const user = await seedUser('tier1', BigInt(TIER1_CAP + 1_000_000));

    const body = await limits(user.userId);

    expect(body.headroom).toEqual(money(0));
  });

  it('returns zeros for a tier 0 user', async () => {
    const user = await seedUser('tier0');

    const body = await limits(user.userId);

    expect(body).toMatchObject({
      tier: 'tier0',
      dailyLimit: money(0),
      remainingToday: money(0),
      balanceCap: money(0),
      headroom: money(0),
    });
  });

  it('reports no cap and no headroom for tier 3', async () => {
    const user = await seedUser('tier3');

    const body = await limits(user.userId);

    expect(body.tier).toBe('tier3');
    expect(body.balanceCap).toBeNull();
    expect(body.headroom).toBeNull();
  });

  describe('agrees with enforcement at the boundary', () => {
    it('allows a transfer of exactly remainingToday and rejects one kobo more', async () => {
      const sender = await seedUser('tier1', 20_000_000n);
      const recipient = await seedUser('tier1');
      await transfer(sender.userId, recipient.userId, 1_200_000);
      await withdraw(sender.userId, sender.bankAccountId, 300_000);
      const remaining = Number(
        ((await limits(sender.userId)).remainingToday as { amount: string })
          .amount,
      );
      expect(remaining).toBe(TIER1_LIMIT - 1_500_000);

      await expect(
        transfer(sender.userId, recipient.userId, remaining + 1),
      ).rejects.toBeInstanceOf(DailyLimitExceededException);
      await transfer(sender.userId, recipient.userId, remaining);

      const after = await limits(sender.userId);
      expect(after.remainingToday).toEqual(money(0));
      await expect(
        transfer(sender.userId, recipient.userId, 10_000),
      ).rejects.toBeInstanceOf(DailyLimitExceededException);
    });

    it('allows funding exactly the headroom and rejects one kobo more', async () => {
      const user = await seedUser();
      await fund(user.userId, 4_000_000);
      const headroom = Number(
        ((await limits(user.userId)).headroom as { amount: string }).amount,
      );
      expect(headroom).toBe(TIER1_CAP - 4_000_000);

      await expect(fund(user.userId, headroom + 1)).rejects.toBeInstanceOf(
        BalanceCapExceededException,
      );
      await fund(user.userId, headroom);

      const after = await limits(user.userId);
      expect(after.headroom).toEqual(money(0));
      expect(after.pendingFunding).toEqual(money(TIER1_CAP));
    });
  });
});
