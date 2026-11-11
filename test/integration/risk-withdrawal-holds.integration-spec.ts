import { Money } from '../../src/shared/primitives/money';
import { WITHDRAWAL_UNDER_REVIEW_MESSAGE } from '../../src/modules/withdrawals/withdrawals.service';
import { assertInvariantHolds } from './support/ledger-invariant';
import { addTestRestriction } from './support/restrictions';
import {
  RiskTestContext,
  RiskUser,
  createRiskTestContext,
  destroyRiskTestContext,
  insertFlag,
  payoutsFor,
  sendP2p,
  seedRiskUser,
  setRule,
  statusOf,
  withdraw,
} from './support/risk-test-context';

jest.setTimeout(180_000);

describe('withdrawals held under review', () => {
  let ctx: RiskTestContext;

  beforeAll(async () => {
    ctx = await createRiskTestContext();
  });

  afterAll(async () => {
    await destroyRiskTestContext(ctx);
  });

  const openFlags = (userId: string) =>
    ctx.flagRepo.findBy({ userId, status: 'open' });

  async function receiveFromSenders(
    recipient: RiskUser,
    senders: number,
    eachMinor = 200_000,
  ): Promise<RiskUser[]> {
    const list: RiskUser[] = [];
    for (let i = 0; i < senders; i++) {
      const sender = await seedRiskUser(ctx, {
        balanceMinor: 500_000n,
        ageDays: 30,
      });
      await sendP2p(ctx, sender, recipient, eachMinor);
      list.push(sender);
    }
    return list;
  }

  async function expectHeld(user: RiskUser, amount: number) {
    const { reference, response } = await withdraw(ctx, user, amount);
    expect(response.status).toBe('under_review');
    expect(response.message).toBe(WITHDRAWAL_UNDER_REVIEW_MESSAGE);
    expect(await statusOf(ctx, reference)).toBe('under_review');
    expect(payoutsFor(ctx, reference)).toHaveLength(0);
    return reference;
  }

  async function expectSent(user: RiskUser, amount: number) {
    const { reference, response } = await withdraw(ctx, user, amount);
    expect(response.status).toBe('pending');
    expect(response.message).toBeUndefined();
    expect(await statusOf(ctx, reference)).toBe('pending');
    expect(payoutsFor(ctx, reference)).toHaveLength(1);
    return reference;
  }

  describe('mule_fan_in', () => {
    it('holds a withdrawal of at least half the inflow from 5 distinct senders', async () => {
      const mule = await seedRiskUser(ctx, { ageDays: 30 });
      await receiveFromSenders(mule, 5);

      await expectHeld(mule, 500_000);

      const [flag] = await openFlags(mule.userId);
      expect(flag).toMatchObject({
        ruleCode: 'mule_fan_in',
        enforced: true,
        hitCount: 1,
        kind: 'fraud',
      });
      expect(flag.transactionId).not.toBeNull();
      expect(flag.evidence[0]).toMatchObject({
        distinctSenders: 5,
        inflowMinor: '1000000',
        withdrawalMinor: '500000',
      });
      await assertInvariantHolds(ctx.accountRepo);
    });

    it('lets the withdrawal through with only 4 senders', async () => {
      const user = await seedRiskUser(ctx, { ageDays: 30 });
      await receiveFromSenders(user, 4);

      await expectSent(user, 700_000);

      expect(await openFlags(user.userId)).toHaveLength(0);
    });

    it('lets a withdrawal under half the inflow through', async () => {
      const user = await seedRiskUser(ctx, { ageDays: 30 });
      await receiveFromSenders(user, 5);

      await expectSent(user, 400_000);

      expect(await openFlags(user.userId)).toHaveLength(0);
    });
  });

  describe('new_account_large_withdrawal', () => {
    it('holds ₦100,000 from an account under 7 days old', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 12_000_000n,
        ageDays: 2,
      });

      await expectHeld(user, 10_000_000);

      const [flag] = await openFlags(user.userId);
      expect(flag).toMatchObject({
        ruleCode: 'new_account_large_withdrawal',
        enforced: true,
      });
    });

    it('lets the same amount through from an account 7 days old', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 12_000_000n,
        ageDays: 7,
      });

      await expectSent(user, 10_000_000);

      expect(await openFlags(user.userId)).toHaveLength(0);
    });

    it('lets a smaller withdrawal through from a new account', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 12_000_000n,
        ageDays: 1,
      });

      await expectSent(user, 9_999_999);

      expect(await openFlags(user.userId)).toHaveLength(0);
    });
  });

  describe('tainted_inflow', () => {
    async function receiveFromSender(amountMinor: number) {
      const recipient = await seedRiskUser(ctx, { ageDays: 30 });
      const [sender] = await receiveFromSenders(recipient, 1, amountMinor);
      return { recipient, sender };
    }

    it('holds when ₦5,000 came from a user with an open enforced flag', async () => {
      const { recipient, sender } = await receiveFromSender(500_000);
      await insertFlag(ctx, sender.userId);

      await expectHeld(recipient, 100_000);

      const [flag] = await openFlags(recipient.userId);
      expect(flag).toMatchObject({
        ruleCode: 'tainted_inflow',
        enforced: true,
      });
      expect(flag.evidence[0]).toMatchObject({
        taintedSenders: [sender.userId],
        taintedInflowMinor: '500000',
      });
    });

    it('holds when the sender has an active fraud restriction', async () => {
      const { recipient, sender } = await receiveFromSender(500_000);
      await addTestRestriction(ctx.dataSource, sender.userId, {
        reason: 'fraud',
      });

      await expectHeld(recipient, 100_000);
    });

    it('lets the withdrawal through when the inflow is under ₦5,000', async () => {
      const { recipient, sender } = await receiveFromSender(499_999);
      await insertFlag(ctx, sender.userId);

      await expectSent(recipient, 100_000);
    });

    it('lets the withdrawal through when the sender is clean', async () => {
      const { recipient } = await receiveFromSender(500_000);

      await expectSent(recipient, 100_000);
    });

    it('ignores a sender whose flag was cleared or is only a shadow flag', async () => {
      const { recipient, sender } = await receiveFromSender(500_000);
      await insertFlag(ctx, sender.userId, { status: 'cleared' });
      await insertFlag(ctx, sender.userId, {
        ruleCode: 'send_burst',
        enforced: false,
      });

      await expectSent(recipient, 100_000);
    });
  });

  describe('holding on an open enforced flag', () => {
    it('holds every withdrawal of a user with an open enforced flag, with no rule tripping', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 2_000_000n,
        ageDays: 30,
      });
      await insertFlag(ctx, user.userId);

      await expectHeld(user, 100_000);
      await expectHeld(user, 100_000);

      expect(await ctx.flagRepo.countBy({ userId: user.userId })).toBe(1);
    });

    it('keeps holding while the flag is in review, and stops once it is cleared', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 2_000_000n,
        ageDays: 30,
      });
      const flag = await insertFlag(ctx, user.userId, { status: 'reviewing' });

      await expectHeld(user, 100_000);

      await ctx.flagRepo.update({ id: flag.id }, { status: 'cleared' });
      await expectSent(user, 100_000);
    });

    it('holds only withdrawals: the user still sends and receives P2P', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 2_000_000n,
        ageDays: 30,
      });
      const friend = await seedRiskUser(ctx, {
        balanceMinor: 2_000_000n,
        ageDays: 30,
      });
      await insertFlag(ctx, user.userId);

      await sendP2p(ctx, user, friend, 200_000);
      await sendP2p(ctx, friend, user, 200_000);
    });

    it('shows the same message whatever the cause', async () => {
      const flagged = await seedRiskUser(ctx, {
        balanceMinor: 2_000_000n,
        ageDays: 30,
      });
      await insertFlag(ctx, flagged.userId);
      const newcomer = await seedRiskUser(ctx, {
        balanceMinor: 12_000_000n,
        ageDays: 1,
      });

      const a = await withdraw(ctx, flagged, 100_000);
      const b = await withdraw(ctx, newcomer, 10_000_000);

      expect(a.response.message).toBe(b.response.message);
      expect(a.response.message).toBe(WITHDRAWAL_UNDER_REVIEW_MESSAGE);
    });
  });

  describe('rule modes and repeat hits', () => {
    it('counts a repeat hit on the open flag instead of adding another', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 25_000_000n,
        ageDays: 1,
      });

      await expectHeld(user, 10_000_000);
      await expectHeld(user, 10_000_000);

      const flags = await ctx.flagRepo.findBy({ userId: user.userId });
      expect(flags).toHaveLength(1);
      expect(flags[0].hitCount).toBe(2);
      expect(flags[0].evidence).toHaveLength(2);
    });

    it('opens a new flag after the first one is resolved', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 25_000_000n,
        ageDays: 1,
      });
      await expectHeld(user, 10_000_000);
      await ctx.flagRepo.update({ userId: user.userId }, { status: 'cleared' });

      await expectHeld(user, 10_000_000);

      expect(await ctx.flagRepo.countBy({ userId: user.userId })).toBe(2);
    });

    describe('with a rule in shadow or off', () => {
      afterEach(async () => {
        await setRule(ctx, 'new_account_large_withdrawal', { mode: 'enforce' });
      });

      it('records a shadow flag and holds nothing', async () => {
        await setRule(ctx, 'new_account_large_withdrawal', { mode: 'shadow' });
        const user = await seedRiskUser(ctx, {
          balanceMinor: 12_000_000n,
          ageDays: 1,
        });

        await expectSent(user, 10_000_000);

        const [flag] = await ctx.flagRepo.findBy({ userId: user.userId });
        expect(flag).toMatchObject({
          ruleCode: 'new_account_large_withdrawal',
          enforced: false,
        });
      });

      it('does not let a shadow flag hold later withdrawals', async () => {
        await setRule(ctx, 'new_account_large_withdrawal', { mode: 'shadow' });
        const user = await seedRiskUser(ctx, {
          balanceMinor: 12_000_000n,
          ageDays: 1,
        });
        await expectSent(user, 10_000_000);

        await setRule(ctx, 'new_account_large_withdrawal', { mode: 'off' });
        await expectSent(user, 100_000);
      });

      it('records nothing when the rule is off', async () => {
        await setRule(ctx, 'new_account_large_withdrawal', { mode: 'off' });
        const user = await seedRiskUser(ctx, {
          balanceMinor: 12_000_000n,
          ageDays: 1,
        });

        await expectSent(user, 10_000_000);

        expect(await ctx.flagRepo.countBy({ userId: user.userId })).toBe(0);
      });

      it('holds on an enforce-mode trip even when the open flag it lands on began as shadow', async () => {
        await setRule(ctx, 'new_account_large_withdrawal', { mode: 'shadow' });
        const user = await seedRiskUser(ctx, {
          balanceMinor: 25_000_000n,
          ageDays: 1,
        });
        await expectSent(user, 10_000_000);

        await setRule(ctx, 'new_account_large_withdrawal', { mode: 'enforce' });
        await expectHeld(user, 10_000_000);

        const [flag] = await ctx.flagRepo.findBy({ userId: user.userId });
        expect(flag).toMatchObject({ enforced: false, hitCount: 2 });
      });
    });

    it('reads thresholds from the rule params', async () => {
      await setRule(ctx, 'new_account_large_withdrawal', {
        params: { minAmountMinor: 50_000 },
      });
      try {
        const user = await seedRiskUser(ctx, {
          balanceMinor: 1_000_000n,
          ageDays: 1,
        });
        await expectHeld(user, 60_000);
      } finally {
        await setRule(ctx, 'new_account_large_withdrawal', {
          params: { minAmountMinor: 10_000_000 },
        });
      }
    });
  });

  describe('a withdrawal that did not post', () => {
    it('leaves no flag behind when the balance is too low', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 1_000_000n,
        ageDays: 1,
      });

      await expect(withdraw(ctx, user, 10_000_000)).rejects.toThrow();

      expect(await ctx.flagRepo.countBy({ userId: user.userId })).toBe(0);
    });
  });

  describe('how a held withdrawal is treated', () => {
    async function heldWithdrawal() {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 12_000_000n,
        ageDays: 1,
      });
      const reference = await expectHeld(user, 10_000_000);
      return { user, reference };
    }

    it('debits the wallet at once, like a pending withdrawal', async () => {
      const { user } = await heldWithdrawal();

      const wallet = await ctx.accountRepo.findOneByOrFail({
        id: user.walletId,
      });
      expect(wallet.balance).toBe(12_000_000n - 10_000_000n - 3_000n);
      await assertInvariantHolds(ctx.accountRepo);
    });

    it('counts towards the daily outflow and the bank-account total', async () => {
      const { user } = await heldWithdrawal();
      const since = new Date(Date.now() - 60 * 60 * 1000);

      const debited = await ctx.dataSource.transaction((manager) =>
        ctx.ledgerService.getDebitedSince(manager, user.userId, since),
      );
      const toBank = await ctx.dataSource.transaction((manager) =>
        ctx.ledgerService.getWithdrawnToBankAccount(
          manager,
          user.userId,
          user.bankAccountId,
        ),
      );

      expect(debited).toEqual(Money.of(10_000_000n, 'NGN'));
      expect(toBank).toEqual(Money.of(10_000_000n, 'NGN'));
    });

    it('is not offered to the withdrawal poll, so Kora is never asked about it', async () => {
      const { reference } = await heldWithdrawal();

      const stale = await ctx.ledgerService.findStaleWithdrawalTransactions(
        new Date(Date.now() + 60_000),
      );

      expect(stale.map((s) => s.reference)).not.toContain(reference);
    });

    it('shows in withdrawal history as under review', async () => {
      const { user, reference } = await heldWithdrawal();

      const history = await ctx.withdrawalsService.getWithdrawalHistory(
        user.userId,
        { limit: 10 },
      );

      expect(history.items.find((i) => i.reference === reference)?.status).toBe(
        'under_review',
      );
    });

    it('is counted as money the provider still holds, for reconciliation', async () => {
      const { reference } = await heldWithdrawal();
      const tx = await ctx.transactionRepo.findOneByOrFail({ reference });

      const total = await ctx.ledgerService.getHeldWithdrawalTotal(
        'kora',
        'NGN',
      );

      expect(total.amount).toBeGreaterThanOrEqual(tx.amount + 3_000n);
    });

    it('answers a retry of the same reference as still under review, without a second debit', async () => {
      const user = await seedRiskUser(ctx, {
        balanceMinor: 12_000_000n,
        ageDays: 1,
      });
      const first = await withdraw(ctx, user, 10_000_000, 'wd-retry-held');

      const retry = await withdraw(ctx, user, 10_000_000, 'wd-retry-held');

      expect(first.response.status).toBe('under_review');
      expect(retry.response.status).toBe('under_review');
      expect(retry.response.message).toBe(WITHDRAWAL_UNDER_REVIEW_MESSAGE);
      expect(
        await ctx.transactionRepo.countBy({ reference: 'wd-retry-held' }),
      ).toBe(1);
    });
  });
});
