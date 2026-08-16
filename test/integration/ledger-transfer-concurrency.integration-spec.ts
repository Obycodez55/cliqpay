import { randomUUID } from 'crypto';
import { Money } from '../../src/shared/primitives/money';
import { InsufficientFundsException } from '../../src/modules/ledger/internal/errors';
import {
  LedgerTestContext,
  createLedgerTestContext,
  destroyLedgerTestContext,
  seedUserWithWallet,
} from './support/ledger-test-context';

jest.setTimeout(180_000);

// Gating criteria per docs/architecture.md §6 Phase 3 and issue #22 — these
// four are acceptance criteria, not follow-up work, since a reversed lock
// order or a check-before-lock passes every single-threaded test and only
// fails under real concurrent load. Iteration counts stay modest for a
// normal run (FC_NUM_RUNS-style env override, same pattern as
// ledger-funding-invariant.integration-spec.ts), heavier runs belong to the
// nightly cadence.
const iterations = process.env.FC_NUM_RUNS
  ? parseInt(process.env.FC_NUM_RUNS, 10)
  : 15;

// Summed across every entry rather than compared against "the latest
// entry's running_balance" — two genuinely concurrent transactions can
// write entries for the same account with the same microsecond-resolution
// createdAt, and ledger_entries.id is a random UUID, not a sequence, so
// "latest by (createdAt, id)" has no reliable meaning when timestamps tie.
// The sum is unambiguous regardless of write order.
async function assertCacheMatchesLedger(
  ctx: LedgerTestContext,
  accountId: string,
): Promise<void> {
  const account = await ctx.accountRepo.findOneByOrFail({ id: accountId });
  const entries = await ctx.ledgerEntryRepo.findBy({ accountId });
  const netFromEntries = entries.reduce(
    (sum, entry) =>
      entry.direction === 'credit' ? sum + entry.amount : sum - entry.amount,
    0n,
  );
  expect(account.balance).toBe(netFromEntries);
}

describe('LedgerService.postTransfer — concurrency', () => {
  let ctx: LedgerTestContext;
  let identitySeq = 0;

  function nextIdentity(): { email: string; phone: string; username: string } {
    identitySeq += 1;
    const n = identitySeq;
    return {
      email: `xfer-concurrency-${n}@example.com`,
      phone: `+2348${String(30_000_000 + n).padStart(8, '0')}`,
      username: `xfer_concurrency_user_${n}`,
    };
  }

  async function fundedWallet(amountMinor: bigint) {
    const { userId, walletId } = await seedUserWithWallet(ctx, nextIdentity());
    const reference = `cliqpay-xfer-conc-fund-${randomUUID()}`;
    await ctx.ledgerService.createPendingFundingTransaction({
      reference,
      provider: 'kora',
      providerReference: reference,
      amount: Money.of(amountMinor, 'NGN'),
      recipientWalletId: walletId,
      metadata: { checkoutUrl: null, grossAmount: null },
    });
    const result = await ctx.ledgerService.postFunding({
      reference,
      netAmount: Money.of(amountMinor, 'NGN'),
      providerFee: Money.zero('NGN'),
      providerStatus: 'success',
    });
    if (!result) {
      throw new Error(
        `fundedWallet: postFunding returned null for "${reference}"`,
      );
    }
    return { userId, walletId };
  }

  beforeAll(async () => {
    ctx = await createLedgerTestContext();
  });

  afterAll(async () => {
    await destroyLedgerTestContext(ctx);
  });

  // (1) Bidirectional deadlock — the first place the ascending-account_id
  // lock rule is actually load-bearing in both directions at once. Without
  // it, A→B and B→A firing concurrently would each lock their own "sender"
  // row first and then block waiting for the other's, a classic deadlock
  // that Postgres detects and kills one side of with a 40P01 error —
  // exactly the failure this test rules out.
  it('never deadlocks when A→B and B→A transfers fire concurrently, repeated across iterations', async () => {
    const a = await fundedWallet(50_000_000n);
    const b = await fundedWallet(50_000_000n);

    for (let i = 0; i < iterations; i++) {
      const results = await Promise.allSettled([
        ctx.ledgerService.postTransfer({
          reference: `cliqpay-xfer-deadlock-ab-${i}-${randomUUID()}`,
          senderWalletId: a.walletId,
          recipientWalletId: b.walletId,
          amount: Money.of(1_000n, 'NGN'),
          platformFee: Money.zero('NGN'),
        }),
        ctx.ledgerService.postTransfer({
          reference: `cliqpay-xfer-deadlock-ba-${i}-${randomUUID()}`,
          senderWalletId: b.walletId,
          recipientWalletId: a.walletId,
          amount: Money.of(1_000n, 'NGN'),
          platformFee: Money.zero('NGN'),
        }),
      ]);

      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
    }

    await assertCacheMatchesLedger(ctx, a.walletId);
    await assertCacheMatchesLedger(ctx, b.walletId);
    // Equal amounts moved each direction every iteration — both wallets
    // return to their starting balance.
    const accountA = await ctx.accountRepo.findOneByOrFail({ id: a.walletId });
    const accountB = await ctx.accountRepo.findOneByOrFail({ id: b.walletId });
    expect(accountA.balance).toBe(50_000_000n);
    expect(accountB.balance).toBe(50_000_000n);
  });

  // (2) Concurrent double-spend — proves lock-then-check, not check-then-lock.
  // A sender who can afford exactly one of N concurrent transfers must have
  // exactly one commit; every other request must fail with
  // InsufficientFundsException, never partially succeed or overdraw.
  it('lets exactly one of N concurrent transfers commit when the sender can afford only one', async () => {
    const transferAmount = 1_000_000n;
    const sender = await fundedWallet(transferAmount);
    const concurrency = 8;
    const recipients = await Promise.all(
      Array.from({ length: concurrency }, () => fundedWallet(0n)),
    );

    const results = await Promise.allSettled(
      recipients.map((recipient, i) =>
        ctx.ledgerService.postTransfer({
          reference: `cliqpay-xfer-doublespend-${i}-${randomUUID()}`,
          senderWalletId: sender.walletId,
          recipientWalletId: recipient.walletId,
          amount: Money.of(transferAmount, 'NGN'),
          platformFee: Money.zero('NGN'),
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(concurrency - 1);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(InsufficientFundsException);
    }

    const senderAccount = await ctx.accountRepo.findOneByOrFail({
      id: sender.walletId,
    });
    expect(senderAccount.balance).toBe(0n);
    await assertCacheMatchesLedger(ctx, sender.walletId);

    const winner = fulfilled[0];
    const creditedRecipient = recipients.find(
      (r) => r.userId === winner.value.recipientUserId,
    )!;
    const creditedAccount = await ctx.accountRepo.findOneByOrFail({
      id: creditedRecipient.walletId,
    });
    expect(creditedAccount.balance).toBe(transferAmount);
    await assertCacheMatchesLedger(ctx, creditedRecipient.walletId);

    // Every other recipient got nothing.
    for (const recipient of recipients) {
      if (recipient.walletId === creditedRecipient.walletId) continue;
      const account = await ctx.accountRepo.findOneByOrFail({
        id: recipient.walletId,
      });
      expect(account.balance).toBe(0n);
    }
  });
});
