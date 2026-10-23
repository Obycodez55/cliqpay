import { randomUUID } from 'crypto';
import { Money } from '../../src/shared/primitives/money';
import { holdUserLock, trackSettled, waitBriefly } from './support/user-lock';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
} from './support/payments-test-context';
import {
  TIER1_CAP,
  balanceOf,
  creditWallet,
  deliverChargeSuccess,
  seedPendingFunding,
  seedUser,
} from './support/funding-completion';
import { assertInvariantHolds } from './support/ledger-invariant';

jest.setTimeout(300_000);

const ROUNDS = 8;
const NGN = (minor: bigint) => Money.of(minor, 'NGN');

describe('Funding completion racing other credits and debits (issue #48)', () => {
  let ctx: PaymentsTestContext;

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  const statusOf = async (reference: string) =>
    (await ctx.transactionRepo.findOneByOrFail({ reference })).status;

  // The same lock-then-check-then-post a P2P transfer does in
  // TransfersService.finalizeTransfer.
  async function transfer(
    senderId: string,
    senderWalletId: string,
    recipientId: string,
    recipientWalletId: string,
    amount: bigint,
  ): Promise<'sent' | 'refused'> {
    try {
      await ctx.dataSource.transaction(async (manager) => {
        await ctx.kycService.checkTransferLimits(
          manager,
          senderId,
          recipientId,
          NGN(amount),
          {
            readDebitedSince: (m, since) =>
              ctx.ledgerService.getDebitedSince(m, senderId, since),
            readRecipientBalanceAndPending: (m) =>
              ctx.ledgerService.getBalanceAndPendingFunding(m, recipientId),
          },
        );
        await ctx.ledgerService.postTransferWithinTransaction(manager, {
          reference: `cliqpay-xfer-${randomUUID()}`,
          senderWalletId,
          recipientWalletId,
          amount: NGN(amount),
          platformFee: Money.zero('NGN'),
        });
      });
      return 'sent';
    } catch {
      return 'refused';
    }
  }

  it('does not complete a funding while another operation holds the user lock', async () => {
    const { userId, walletId } = await seedUser(ctx, 'tier1');
    const reference = await seedPendingFunding(ctx, walletId, 1_000_000n);
    const lock = await holdUserLock(ctx.dataSource, userId);

    const { isSettled, promise } = trackSettled(
      deliverChargeSuccess(ctx, reference, 1_000_000n),
    );
    await waitBriefly();
    expect(isSettled()).toBe(false);

    await lock.release();
    await promise;
    expect(await statusOf(reference)).toBe('completed');
  });

  it('a funding racing a P2P transfer to the same user, with headroom for only one, never takes the wallet over the cap', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const sender = await seedUser(ctx, 'tier3');
      await creditWallet(ctx, sender.walletId, 5_000_000n);
      const recipient = await seedUser(ctx, 'tier1');
      await creditWallet(ctx, recipient.walletId, TIER1_CAP - 1_500_000n);
      // Aged past the pending window so the transfer's cap check does not
      // count it: the case initiation can no longer protect.
      const reference = await seedPendingFunding(
        ctx,
        recipient.walletId,
        1_000_000n,
        25,
      );

      const [, outcome] = await Promise.all([
        deliverChargeSuccess(ctx, reference, 1_000_000n),
        transfer(
          sender.userId,
          sender.walletId,
          recipient.userId,
          recipient.walletId,
          1_000_000n,
        ),
      ]);

      const balance = await balanceOf(ctx, recipient.walletId);
      expect(balance).toBeLessThanOrEqual(TIER1_CAP);
      const status = await statusOf(reference);
      expect(
        (status === 'completed' && outcome === 'refused') ||
          (status === 'held' && outcome === 'sent'),
      ).toBe(true);
      await assertInvariantHolds(ctx.accountRepo);
    }
  });

  it('two fundings completing together, with headroom for only one, credit one and hold the other', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { walletId } = await seedUser(ctx, 'tier1');
      await creditWallet(ctx, walletId, TIER1_CAP - 1_500_000n);
      const first = await seedPendingFunding(ctx, walletId, 1_000_000n, 25);
      const second = await seedPendingFunding(ctx, walletId, 1_000_000n, 25);

      await Promise.all([
        deliverChargeSuccess(ctx, first, 1_000_000n),
        deliverChargeSuccess(ctx, second, 1_000_000n),
      ]);

      const statuses = [await statusOf(first), await statusOf(second)].sort();
      expect(statuses).toEqual(['completed', 'held']);
      expect(await balanceOf(ctx, walletId)).toBe(TIER1_CAP - 500_000n);
      await assertInvariantHolds(ctx.accountRepo);
    }
  });

  it('a funding racing a withdrawal from the same wallet ends under the cap, whichever lands first', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { userId, walletId } = await seedUser(ctx, 'tier1');
      await creditWallet(ctx, walletId, TIER1_CAP - 500_000n);
      const reference = await seedPendingFunding(ctx, walletId, 1_000_000n, 25);

      await Promise.all([
        deliverChargeSuccess(ctx, reference, 1_000_000n),
        ctx.dataSource.transaction(async (manager) => {
          await ctx.kycService.checkAndReserveLimit(
            manager,
            userId,
            NGN(600_000n),
            (m, since) => ctx.ledgerService.getDebitedSince(m, userId, since),
          );
          await ctx.ledgerService.postWithdrawalWithinTransaction(manager, {
            reference: `cliqpay-wd-${randomUUID()}`,
            walletId,
            provider: 'kora',
            amount: NGN(600_000n),
            platformFee: Money.zero('NGN'),
            providerFee: Money.zero('NGN'),
            bankAccount: {
              id: randomUUID(),
              bankCode: '033',
              bankName: 'Test Bank',
              accountNumber: '******7890',
              accountName: 'Ada Lovelace',
            },
          });
        }),
      ]);

      const balance = await balanceOf(ctx, walletId);
      expect(balance).toBeLessThanOrEqual(TIER1_CAP);
      const status = await statusOf(reference);
      expect(balance).toBe(
        status === 'completed'
          ? TIER1_CAP - 500_000n + 1_000_000n - 600_000n
          : TIER1_CAP - 500_000n - 600_000n,
      );
    }
  });
});
