import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { KycVerification } from '../../src/modules/kyc/entities/kyc-verification.entity';
import { BankAccountCoolingException } from '../../src/modules/withdrawals/internal/errors';
import { AuditEvent } from '../../src/shared/audit/entities/audit-event.entity';
import {
  WithdrawalsTestContext,
  createWithdrawalsTestContext,
  destroyWithdrawalsTestContext,
  seedBankAccount,
} from './support/withdrawals-test-context';
import {
  SECURITY_ALERT_SUBJECT,
  createAuthTestHelpers,
  extractSixDigitCode,
  stepUpCodeSubject,
  waitFor,
} from './support/auth-test-helpers';
import {
  HOUR_MS,
  createAccountControlsHelpers,
  money,
} from './support/account-controls-helpers';
import { dataOf } from './support/api-response';

jest.setTimeout(180_000);

const LEGAL_NAME = 'Ada Olu Lovelace';

describe('Bank account alert and cooling', () => {
  let ctx: WithdrawalsTestContext;
  let auth: ReturnType<typeof createAuthTestHelpers>;
  const h = createAccountControlsHelpers(() => ctx);
  let seq = 0;

  beforeAll(async () => {
    ctx = await createWithdrawalsTestContext();
    auth = createAuthTestHelpers(ctx);
  });

  afterAll(async () => {
    await destroyWithdrawalsTestContext(ctx);
  });

  async function verifiedUser() {
    seq += 1;
    const { user } = await auth.registerUser({
      email: `cooling-${seq}@example.com`,
      username: `cooling_${seq}`,
      phone: `+23480881${String(10_000 + seq).padStart(5, '0')}`,
    });
    const { tokens } = await auth.loginAndVerify(
      user.email,
      'a-strong-unique-passphrase',
    );
    await ctx.dataSource
      .getRepository(KycVerification)
      .save({ userId: user.id, verifiedLegalName: LEGAL_NAME });
    return { user, tokens };
  }

  async function saveAccount(
    accessToken: string,
    accountNumber: string,
    holderName: string,
  ) {
    ctx.fakeAdapter.setResolveBankAccountResult('033', accountNumber, {
      status: 'resolved',
      bankName: 'United Bank for Africa',
      accountName: holderName,
    });
    const step = await request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(200);
    const code = extractSixDigitCode(
      auth.latestEmailWithSubject(stepUpCodeSubject('save a bank account'))
        .text,
    );
    return request(ctx.app.getHttpServer())
      .post('/withdrawals/bank-accounts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        bankCode: '033',
        accountNumber,
        challengeId: dataOf<{ challengeId: string }>(step).challengeId,
        code,
      })
      .expect(201);
  }

  describe('saving', () => {
    it('treats an account in the user’s own name, in any order, as fully eligible at once', async () => {
      const { user, tokens } = await verifiedUser();

      const res = await saveAccount(
        tokens.accessToken,
        '0000000101',
        'LOVELACE ADA OLU',
      );

      const body = dataOf<{ createdAt: string; fullyEligibleAt: string }>(res);
      expect(new Date(body.fullyEligibleAt).getTime()).toBeLessThanOrEqual(
        new Date(body.createdAt).getTime() + 1000,
      );
      const saved = await ctx.bankAccountRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(saved.fullyEligibleAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('holds a third-party account to 24 hours of cooling', async () => {
      const { user, tokens } = await verifiedUser();

      await saveAccount(tokens.accessToken, '0000000102', 'JOHN SMITH');

      const saved = await ctx.bankAccountRepo.findOneByOrFail({
        userId: user.id,
      });
      const wait = saved.fullyEligibleAt.getTime() - saved.createdAt.getTime();
      expect(wait).toBeGreaterThan(23.9 * HOUR_MS);
      expect(wait).toBeLessThanOrEqual(24.1 * HOUR_MS);
    });

    it('cools an account when the user has no verified name', async () => {
      seq += 1;
      const { user } = await auth.registerUser({
        email: `cooling-unverified-${seq}@example.com`,
        username: `cooling_unv_${seq}`,
        phone: `+23480882${String(10_000 + seq).padStart(5, '0')}`,
      });
      const { tokens } = await auth.loginAndVerify(
        user.email,
        'a-strong-unique-passphrase',
      );

      await saveAccount(tokens.accessToken, '0000000103', 'ADA LOVELACE');

      const saved = await ctx.bankAccountRepo.findOneByOrFail({
        userId: user.id,
      });
      expect(saved.fullyEligibleAt.getTime()).toBeGreaterThan(
        Date.now() + 23 * HOUR_MS,
      );
    });

    it('sends a security alert naming the bank, the masked number and the holder, and audits it', async () => {
      const { user, tokens } = await verifiedUser();

      await saveAccount(tokens.accessToken, '0000000104', 'JOHN SMITH');

      await waitFor(() =>
        ctx.emailAdapter.sent.some(
          (m) =>
            m.to === user.email &&
            m.subject === SECURITY_ALERT_SUBJECT &&
            m.text.includes('United Bank for Africa'),
        ),
      );
      const alert = ctx.emailAdapter.sent.find(
        (m) =>
          m.to === user.email &&
          m.subject === SECURITY_ALERT_SUBJECT &&
          m.text.includes('United Bank for Africa'),
      )!;
      expect(alert.text).toContain('******0104');
      expect(alert.text).not.toContain('0000000104');
      expect(alert.text).toContain('JOHN SMITH');
      const events = await ctx.dataSource
        .getRepository(AuditEvent)
        .findBy({ actorId: user.id, action: 'bank_account_saved' });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({
        accountNumberLast4: '0104',
        holderNameMatched: false,
      });
    });
  });

  describe('withdrawing while cooling', () => {
    async function seedCooling() {
      const sender = await h.seedUser('cool', { balanceMinor: 20_000_000n });
      const third = await seedBankAccount(ctx, {
        userId: sender.userId,
        accountNumber: '0077000001',
        accountName: 'John Smith',
        fullyEligibleAt: new Date(Date.now() + 24 * HOUR_MS),
      });
      const own = await seedBankAccount(ctx, {
        userId: sender.userId,
        accountNumber: '0077000002',
        accountName: 'Ada Lovelace',
      });
      return { sender, third, own };
    }

    it('caps the total to a third-party account, not each withdrawal', async () => {
      const { sender, third } = await seedCooling();
      await h.withdraw(sender.userId, third.id, 1_500_000);

      const error = await h
        .withdraw(sender.userId, third.id, 600_000)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BankAccountCoolingException);
      expect((error as BankAccountCoolingException).code).toBe(
        'BANK_ACCOUNT_COOLING',
      );
      const { eligibleAt, limit, remaining } = (
        error as BankAccountCoolingException
      ).details;
      expect(new Date(eligibleAt)).toEqual(third.fullyEligibleAt);
      expect(limit).toEqual(money(2_000_000));
      expect(remaining).toEqual(money(500_000));
      await expect(
        h.withdraw(sender.userId, third.id, 500_000),
      ).resolves.toBeDefined();
    });

    it('leaves an account in the user’s own name uncapped', async () => {
      const { sender, own } = await seedCooling();

      await expect(
        h.withdraw(sender.userId, own.id, 3_000_000),
      ).resolves.toBeDefined();
    });

    it('keeps the caps of two cooling accounts apart', async () => {
      const { sender, third } = await seedCooling();
      const other = await seedBankAccount(ctx, {
        userId: sender.userId,
        accountNumber: '0077000003',
        accountName: 'Jane Roe',
        fullyEligibleAt: new Date(Date.now() + 24 * HOUR_MS),
      });
      await h.withdraw(sender.userId, third.id, 2_000_000);

      await expect(
        h.withdraw(sender.userId, other.id, 1_000_000),
      ).resolves.toBeDefined();
    });

    it('lifts the cap once the account is fully eligible', async () => {
      const { sender, third } = await seedCooling();
      await h.withdraw(sender.userId, third.id, 2_000_000);
      await ctx.bankAccountRepo.update(
        { id: third.id },
        { fullyEligibleAt: new Date(Date.now() - 1000) },
      );

      await expect(
        h.withdraw(sender.userId, third.id, 2_000_000),
      ).resolves.toBeDefined();
    });
  });
  describe('scheduled withdrawals', () => {
    const run = (
      userId: string,
      bankAccountId: string,
      amount: number,
      scheduleCreatedAt = new Date(0),
    ) =>
      ctx.withdrawalsService.executeScheduledWithdrawal(userId, {
        bankAccountId,
        amount,
        reference: `sched_${randomUUID()}_1_1`,
        scheduleId: randomUUID(),
        runNumber: 1,
        scheduleCreatedAt,
      });

    it('rejects a run into a cooling account with the transient bank_account_cooling code', async () => {
      const sender = await h.seedUser('sched-cool', {
        balanceMinor: 20_000_000n,
      });
      const third = await seedBankAccount(ctx, {
        userId: sender.userId,
        accountNumber: '0077000011',
        accountName: 'John Smith',
        fullyEligibleAt: new Date(Date.now() + 24 * HOUR_MS),
      });

      await expect(
        run(sender.userId, third.id, 2_500_000),
      ).rejects.toMatchObject({ failureCode: 'bank_account_cooling' });
    });

    it('rejects a run over the security cooldown cap, unless the schedule predates the cooldown', async () => {
      const sender = await h.seedUser('sched-cooldown', {
        balanceMinor: 20_000_000n,
      });
      const own = await seedBankAccount(ctx, {
        userId: sender.userId,
        accountNumber: '0077000012',
      });
      await h.startCooldown(sender.userId);
      const { startedAt } = await h.cooldownOf(sender.userId);

      await expect(
        run(
          sender.userId,
          own.id,
          2_500_000,
          new Date(startedAt!.getTime() + 1),
        ),
      ).rejects.toMatchObject({ failureCode: 'security_cooldown_limit' });

      await expect(
        run(
          sender.userId,
          own.id,
          2_500_000,
          new Date(startedAt!.getTime() - 1),
        ),
      ).resolves.toMatchObject({ outcome: 'accepted' });
    });
  });
});
