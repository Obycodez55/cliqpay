import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  fundWallet,
  seedBankAccount,
  seedWithdrawalUser,
} from './support/withdrawals-test-context';
import {
  createAuthTestHelpers,
  extractSixDigitCode,
  stepUpCodeSubject,
} from './support/auth-test-helpers';
import { dataOf } from './support/api-response';
import {
  describeSignedAction,
  nowSeconds,
  signedHeaders,
} from './support/signed-actions';
import {
  TEST_DEVICE,
  TEST_DEVICE_ID,
  TEST_DEVICE_KEY,
} from './support/auth-test-helpers';
import { TEST_PIN_PEPPER } from './support/test-app-config';
import { hashTransactionPin } from '../../src/modules/auth/internal/pin.util';
import { User } from '../../src/modules/users/entities/user.entity';

jest.setTimeout(180_000);

const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

describe('device signatures on withdrawals', () => {
  let ctx: WithdrawalsTestContext;
  let helpers: ReturnType<typeof createAuthTestHelpers>;
  let seq = 0;
  const jwtService = new JwtService({ secret: JWT_SECRET });

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext({ providerFee: 3_000 });
    helpers = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  const tokenFor = (userId: string) =>
    jwtService.sign({ sub: userId, sid: 'test-session' });

  const transactionCount = async (reference: string) =>
    (
      await ctx.dataSource.query<unknown[]>(
        `SELECT 1 FROM transactions WHERE reference = $1`,
        [reference],
      )
    ).length;

  describeSignedAction(
    'POST /withdrawals',
    () => ctx,
    { tamper: ['reference', 'amount', 'target'], replays: true },
    async () => {
      seq += 1;
      const { userId, walletId } = await seedWithdrawalUser(ctx, {
        email: `wd-sig-${seq}@example.com`,
        phone: `+2348066${String(100_000 + seq).padStart(6, '0')}`,
        username: `wd_sig_${seq}`,
      });
      await fundWallet(ctx, {
        reference: `cliqpay-fund-${userId}`,
        walletId,
        netAmountMinor: 5_000_000n,
      });
      const bank = await seedBankAccount(ctx, {
        userId,
        accountNumber: `11${String(seq).padStart(8, '0')}`,
      });
      const otherBank = await seedBankAccount(ctx, {
        userId,
        accountNumber: `22${String(seq).padStart(8, '0')}`,
      });
      const reference = `cliqpay-wd-sig-${randomUUID()}`;
      const body = {
        bankAccountId: bank.id,
        amount: 500_000,
        reference,
        pin: '1234',
      };
      const post =
        (payload: Record<string, unknown>) =>
        (headers: Record<string, string>) =>
          request(ctx.app.getHttpServer())
            .post('/withdrawals')
            .set('Authorization', `Bearer ${tokenFor(userId)}`)
            .set(headers)
            .send(payload);
      return {
        userId,
        signs: {
          action: 'withdrawal.initiate',
          reference,
          amount: '500000',
          target: bank.id,
        },
        send: post(body),
        tampered: {
          reference: post({ ...body, reference: `${reference}-x` }),
          amount: post({ ...body, amount: 900_000 }),
          target: post({ ...body, bankAccountId: otherBank.id }),
        },
        expectApplied: async () => {
          expect(await transactionCount(reference)).toBe(1);
        },
        expectUntouched: async () => {
          expect(await transactionCount(reference)).toBe(0);
          expect(await transactionCount(`${reference}-x`)).toBe(0);
          expect(
            (await ctx.accountRepo.findOneByOrFail({ id: walletId })).balance,
          ).toBe(5_000_000n);
        },
      };
    },
  );

  describeSignedAction(
    'POST /withdrawals/bank-accounts',
    () => ctx,
    { tamper: ['reference', 'target'], replays: false },
    async () => {
      seq += 1;
      const { user } = await helpers.registerUser({
        email: `bank-sig-${seq}@example.com`,
        username: `bank_sig_${seq}`,
        phone: `+2348066${String(200_000 + seq).padStart(6, '0')}`,
      });
      const { tokens } = await helpers.loginAndVerify(
        user.email,
        'a-strong-unique-passphrase',
      );
      const stepUp = await request(ctx.app.getHttpServer())
        .post('/withdrawals/bank-accounts/step-up')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({})
        .expect(200);
      const challengeId = dataOf<{ challengeId: string }>(stepUp).challengeId;
      const code = extractSixDigitCode(
        helpers.latestEmailWithSubject(stepUpCodeSubject('save a bank account'))
          .text,
      );
      const body = {
        bankCode: '033',
        accountNumber: '0000000000',
        challengeId,
        code,
      };
      const post =
        (payload: Record<string, unknown>) =>
        (headers: Record<string, string>) =>
          request(ctx.app.getHttpServer())
            .post('/withdrawals/bank-accounts')
            .set('Authorization', `Bearer ${tokens.accessToken}`)
            .set(headers)
            .send(payload);
      return {
        userId: user.id,
        signs: {
          action: 'bank_account.save',
          reference: challengeId,
          amount: '',
          target: '033:0000000000',
        },
        send: post(body),
        tampered: {
          reference: post({ ...body, challengeId: randomUUID() }),
          target: post({ ...body, accountNumber: '0000000001' }),
        },
        expectApplied: async () => {
          expect(await ctx.bankAccountRepo.countBy({ userId: user.id })).toBe(
            1,
          );
        },
        expectUntouched: async () => {
          expect(await ctx.bankAccountRepo.countBy({ userId: user.id })).toBe(
            0,
          );
        },
      };
    },
  );

  describe('a trusted device past its expiresAt', () => {
    it('still refreshes and signs a transfer, while login with its token goes to MFA', async () => {
      seq += 1;
      const { user } = await helpers.registerUser({
        email: `expired-${seq}@example.com`,
        username: `expired_${seq}`,
        phone: `+2348066${String(300_000 + seq).padStart(6, '0')}`,
      });
      const { tokens, trustedDeviceToken } = await helpers.loginAndVerify(
        user.email,
        'a-strong-unique-passphrase',
      );
      await ctx.dataSource
        .getRepository(User)
        .update(
          { id: user.id },
          { emailVerifiedAt: new Date(), kycTier: 'tier3' },
        );
      await ctx.credentialRepo.update(
        { userId: user.id },
        {
          transactionPinHash: await hashTransactionPin('1234', TEST_PIN_PEPPER),
        },
      );
      const wallet = await ctx.accountRepo.findOneByOrFail({ userId: user.id });
      await fundWallet(ctx, {
        reference: `cliqpay-fund-${user.id}`,
        walletId: wallet.id,
        netAmountMinor: 5_000_000n,
      });
      const recipient = await seedWithdrawalUser(ctx, {
        email: `expired-rcpt-${seq}@example.com`,
        phone: `+2348066${String(400_000 + seq).padStart(6, '0')}`,
        username: `expired_rcpt_${seq}`,
      });
      await ctx.trustedDeviceRepo.update(
        { userId: user.id },
        { expiresAt: new Date(Date.now() - 60_000) },
      );

      ctx.config.device.keyRequired = true;
      try {
        const reference = `cliqpay-xfer-expired-${randomUUID()}`;
        const signs = {
          action: 'transfer.send',
          reference,
          amount: '100000',
          target: recipient.userId,
        };
        await request(ctx.app.getHttpServer())
          .post('/transfers')
          .set('Authorization', `Bearer ${tokens.accessToken}`)
          .set(signedHeaders(TEST_DEVICE_KEY, signs, nowSeconds()))
          .send({
            recipientUserId: recipient.userId,
            amount: 100_000,
            reference,
            pin: '1234',
            visibility: 'private',
          })
          .expect(201);

        const refreshed = await helpers.refreshSigned(tokens.refreshToken);
        expect(refreshed.refreshToken).toEqual(expect.any(String));

        const login = await ctx.sessionService.login(
          { email: user.email, password: 'a-strong-unique-passphrase' },
          trustedDeviceToken,
          TEST_DEVICE_ID,
          TEST_DEVICE,
        );
        expect(login.mfaRequired).toBe(true);
      } finally {
        ctx.config.device.keyRequired = false;
      }
    });
  });
});
