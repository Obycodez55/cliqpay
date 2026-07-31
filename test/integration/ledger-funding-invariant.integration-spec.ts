import fc from 'fast-check';
import { randomUUID } from 'crypto';
import { IsNull } from 'typeorm';
import { Money } from '../../src/shared/primitives/money';
import {
  PaymentsTestContext,
  createPaymentsTestContext,
  destroyPaymentsTestContext,
  seedUserWithWallet,
} from './support/payments-test-context';

jest.setTimeout(180_000);

// Property-based coverage per docs/architecture.md §10 and CLAUDE.md
// Testing: random valid operation sequences must never break the §4.3
// ledger invariant. Funding is the only transaction type LedgerService
// posts entries for so far (issue #13) — p2p/withdrawal extend this same
// generator with their own operation kind once those land. Runs against a
// real Postgres (Testcontainers) rather than mocks, since the invariant is
// a real cross-row DB property (account balances + running_balance), not
// something a mock can meaningfully assert.
const numRuns = process.env.FC_NUM_RUNS
  ? parseInt(process.env.FC_NUM_RUNS, 10)
  : 5;

async function assertInvariantHolds(ctx: PaymentsTestContext): Promise<void> {
  const float = await ctx.accountRepo.findOneByOrFail({
    role: 'float',
    provider: 'kora',
    currency: 'NGN',
  });
  const feeIncome = await ctx.accountRepo.findOneByOrFail({
    role: 'fee_income',
    provider: IsNull(),
    currency: 'NGN',
  });
  const wallets = await ctx.accountRepo.findBy({
    role: 'user_wallet',
    currency: 'NGN',
  });
  const walletSum = wallets.reduce((sum, w) => sum + w.balance, 0n);

  expect(float.balance).toBe(walletSum + feeIncome.balance);
}

interface FundingOp {
  netAmountMinor: number;
  feeMinor: number;
}

// Kept well within Postgres bigint range even after summing many of these
// across a whole run — the invariant math itself has no other bound.
const fundingOpArb: fc.Arbitrary<FundingOp> = fc.record({
  netAmountMinor: fc.integer({ min: 100, max: 10_000_000 }),
  feeMinor: fc.integer({ min: 0, max: 50_000 }),
});

describe('Ledger §4.3 invariant — random funding sequences', () => {
  let ctx: PaymentsTestContext;
  let identitySeq = 0;

  // A monotonic counter, not derived from the UUID's characters — a UUID's
  // digit characters alone (after stripping hex letters) can't be trusted
  // to be non-empty or unique enough for a 7-digit phone suffix.
  function nextIdentity(): { email: string; phone: string; username: string } {
    identitySeq += 1;
    const n = identitySeq;
    return {
      email: `invariant-${n}@example.com`,
      phone: `+2348${String(20_000_000 + n).padStart(8, '0')}`,
      username: `invariant_user_${n}`,
    };
  }

  beforeAll(async () => {
    ctx = await createPaymentsTestContext();
  });

  afterAll(async () => {
    await destroyPaymentsTestContext(ctx);
  });

  it('holds after any sequence of successful funding postings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fundingOpArb, { minLength: 1, maxLength: 8 }),
        async (ops) => {
          for (const op of ops) {
            const identity = nextIdentity();
            const { walletId } = await seedUserWithWallet(ctx, identity);
            const reference = `cliqpay-invariant-${randomUUID()}`;
            const netAmount = Money.of(op.netAmountMinor, 'NGN');
            const providerFee = Money.of(op.feeMinor, 'NGN');

            // `amount` mirrors what PaymentsService.fundWallet actually sets
            // it to at initiation — the net amount the client requested, the
            // same value postFunding is later called with — not net+fee.
            // postFunding now rejects a mismatch (H3 fix), so this has to
            // stay in sync with real usage, not just "some deterministic
            // number".
            await ctx.ledgerService.createPendingFundingTransaction({
              reference,
              provider: 'kora',
              providerReference: reference,
              amount: netAmount,
              recipientWalletId: walletId,
              metadata: { checkoutUrl: null, grossAmount: null },
            });

            const result = await ctx.ledgerService.postFunding({
              reference,
              netAmount,
              providerFee,
              providerStatus: 'success',
            });
            expect(result).not.toBeNull();

            await assertInvariantHolds(ctx);
          }
        },
      ),
      { numRuns },
    );
  });

  it('holds after a duplicate delivery of the same posting', async () => {
    await fc.assert(
      fc.asyncProperty(fundingOpArb, async (op) => {
        const identity = nextIdentity();
        const { walletId } = await seedUserWithWallet(ctx, identity);
        const reference = `cliqpay-invariant-dup-${randomUUID()}`;
        const netAmount = Money.of(op.netAmountMinor, 'NGN');
        const providerFee = Money.of(op.feeMinor, 'NGN');

        await ctx.ledgerService.createPendingFundingTransaction({
          reference,
          provider: 'kora',
          providerReference: reference,
          amount: netAmount,
          recipientWalletId: walletId,
          metadata: { checkoutUrl: null, grossAmount: null },
        });

        const facts = {
          reference,
          netAmount,
          providerFee,
          providerStatus: 'success' as const,
        };
        const first = await ctx.ledgerService.postFunding(facts);
        const second = await ctx.ledgerService.postFunding(facts);
        expect(first).not.toBeNull();
        expect(second).toBeNull();

        await assertInvariantHolds(ctx);
      }),
      { numRuns },
    );
  });

  it('fails a transaction rather than crediting a provider-reported amount that does not match what was requested', async () => {
    const identity = nextIdentity();
    const { walletId } = await seedUserWithWallet(ctx, identity);
    const reference = `cliqpay-invariant-mismatch-${randomUUID()}`;
    const requestedAmount = Money.of(100_000n, 'NGN');

    await ctx.ledgerService.createPendingFundingTransaction({
      reference,
      provider: 'kora',
      providerReference: reference,
      amount: requestedAmount,
      recipientWalletId: walletId,
      metadata: { checkoutUrl: null, grossAmount: null },
    });

    // A provider report claiming a wildly different amount than what was
    // actually requested at initiation — the H3 regression.
    const result = await ctx.ledgerService.postFunding({
      reference,
      netAmount: Money.of(99_999_900n, 'NGN'),
      providerFee: Money.zero('NGN'),
      providerStatus: 'success',
    });

    expect(result).toBeNull();

    const transaction = await ctx.transactionRepo.findOneByOrFail({
      reference,
    });
    expect(transaction.status).toBe('failed');

    const entries = await ctx.ledgerEntryRepo.findBy({
      transactionId: transaction.id,
    });
    expect(entries).toHaveLength(0);

    const wallet = await ctx.accountRepo.findOneByOrFail({ id: walletId });
    expect(wallet.balance).toBe(0n);

    await assertInvariantHolds(ctx);
  });
});
