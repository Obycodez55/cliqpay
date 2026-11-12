import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { TEST_JWT_SECRET, TEST_PIN_PEPPER } from './test-app-config';
import { createAuthTestHelpers } from './auth-test-helpers';
import { hashTransactionPin } from '../../../src/modules/auth/internal/pin.util';
import {
  WithdrawalsTestContext,
  fundWallet,
  seedBankAccount,
  seedWithdrawalUser,
} from './withdrawals-test-context';
import { KycTier } from '../../../src/modules/users/users.service';
import { User } from '../../../src/modules/users/entities/user.entity';
import { WalletLimitsResponseDto } from '../../../src/modules/payments/dto/wallet-limits-response.dto';
import { dataOf } from './api-response';

export const HOUR_MS = 60 * 60 * 1000;
export const money = (amount: number | string) => ({
  amount: String(amount),
  currency: 'NGN',
});

export function createAccountControlsHelpers(
  getCtx: () => WithdrawalsTestContext,
) {
  const jwtService = new JwtService({ secret: TEST_JWT_SECRET });
  let seq = 0;

  const token = (userId: string) =>
    jwtService.sign({ sub: userId, sid: 'test-session' });

  const http = () => request(getCtx().app.getHttpServer());

  const authed = (userId: string, method: 'get' | 'post', path: string) =>
    http()
      [method](path)
      .set('Authorization', `Bearer ${token(userId)}`);

  async function seedUser(
    prefix: string,
    options: {
      tier?: KycTier;
      balanceMinor?: bigint;
      bankAccountName?: string;
    } = {},
  ) {
    const ctx = getCtx();
    seq += 1;
    const n = seq;
    const { userId, walletId } = await seedWithdrawalUser(ctx, {
      email: `${prefix}-ctl-${n}@example.com`,
      phone: `+2348066${String(100_000 + n).padStart(6, '0')}`,
      username: `${prefix}_ctl_${n}`,
      kycTier: options.tier ?? 'tier1',
    });
    if (options.balanceMinor !== 0n) {
      await fundWallet(ctx, {
        reference: `cliqpay-ctl-fund-${randomUUID()}`,
        walletId,
        netAmountMinor: options.balanceMinor ?? 20_000_000n,
      });
    }
    const bankAccount = await seedBankAccount(ctx, {
      userId,
      accountNumber: `0066${String(100_000 + n).padStart(6, '0')}`,
      accountName: options.bankAccountName,
    });
    return { userId, walletId, bankAccountId: bankAccount.id };
  }

  // A registered user (so it has an email MFA method for step-up) with a PIN,
  // a verified email, Tier 1 since long ago and a funded wallet.
  async function seedOwner(
    auth: ReturnType<typeof createAuthTestHelpers>,
    pin: string,
  ) {
    const ctx = getCtx();
    seq += 1;
    const { user, wallet } = await auth.registerUser({
      email: `owner-ctl-${seq}@example.com`,
      username: `owner_ctl_${seq}`,
      phone: `+23480991${String(10_000 + seq).padStart(5, '0')}`,
    });
    await ctx.userRepo.update(
      { id: user.id },
      {
        kycTier: 'tier1',
        emailVerifiedAt: new Date(),
        tier1ReachedAt: new Date(Date.now() - 48 * HOUR_MS),
      },
    );
    await ctx.credentialRepo.update(
      { userId: user.id },
      { transactionPinHash: await hashTransactionPin(pin, TEST_PIN_PEPPER) },
    );
    await fundWallet(ctx, {
      reference: `cliqpay-ctl-owner-${seq}`,
      walletId: wallet.id,
      netAmountMinor: 20_000_000n,
    });
    return { userId: user.id, email: user.email };
  }

  const transfer = (
    senderId: string,
    recipientUserId: string,
    amount: number,
    pin = '1234',
  ) =>
    getCtx().transfersService.sendMoney(senderId, {
      recipientUserId,
      amount,
      reference: `cliqpay-ctl-xfer-${randomUUID()}`,
      pin,
      visibility: 'private',
      riskAcknowledged: true,
    });

  const withdraw = (userId: string, bankAccountId: string, amount: number) =>
    getCtx().withdrawalsService.initiateWithdrawal(userId, {
      bankAccountId,
      amount,
      reference: `cliqpay-ctl-wd-${randomUUID()}`,
      pin: '1234',
    });

  const startCooldown = (userId: string) =>
    getCtx().dataSource.transaction((manager) =>
      getCtx().usersService.startSecurityCooldown(
        manager,
        userId,
        'password_changed',
        { type: 'user', id: userId },
      ),
    );

  const cooldownOf = async (userId: string) => {
    const user = await getCtx().userRepo.findOneByOrFail({ id: userId });
    return {
      until: user.securityCooldownUntil,
      startedAt: user.securityCooldownStartedAt,
    };
  };

  const setUser = (userId: string, fields: Partial<User>) =>
    getCtx().userRepo.update({ id: userId }, fields);

  async function limits(userId: string) {
    const res = await authed(userId, 'get', '/wallet/limits').expect(200);
    return dataOf<WalletLimitsResponseDto>(res);
  }

  // Moves a P2P or withdrawal transaction's recorded time back, as if it had
  // happened `hours` ago.
  async function ageDebits(userId: string, hours: number): Promise<void> {
    await getCtx().dataSource.query(
      `UPDATE transactions SET created_at = created_at - make_interval(hours => $2)
       WHERE sender_wallet_id = (SELECT id FROM accounts WHERE user_id = $1 AND role = 'user_wallet')
         AND type IN ('p2p_transfer', 'withdrawal')`,
      [userId, hours],
    );
  }

  return {
    token,
    http,
    authed,
    seedUser,
    seedOwner,
    transfer,
    withdraw,
    startCooldown,
    cooldownOf,
    setUser,
    limits,
    ageDebits,
  };
}
