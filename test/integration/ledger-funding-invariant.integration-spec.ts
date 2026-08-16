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
// ledger invariant. Funding was the only transaction type LedgerService
// posted entries for at first (issue #13); transfers (issue #22) extend
// this same generator with their own operation kind below rather than a
// separate property-test file — withdrawal does the same once it lands.
// Runs against a real Postgres (Testcontainers) rather than mocks, since
// the invariant is a real cross-row DB property (account balances +
// running_balance), not something a mock can meaningfully assert.
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

// §2 ("accounts.balance is a cache") as a checkable property: after any
// operation, an account's cached balance must equal its own latest
// ledger_entries.running_balance — checked directly against the DB, not
// against whatever the posting call happened to return.
// Summed across every entry rather than compared against "the latest
// entry's running_balance" — see the identical helper in
// ledger-transfer-concurrency.integration-spec.ts for why "latest by
// (createdAt, id)" isn't reliable once concurrent writers are involved.
async function assertCacheMatchesLedger(
  ctx: PaymentsTestContext,
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

interface TransferOp {
  // Funds the sender's fresh wallet first so the transfer below is always
  // affordable — bounds are chosen so fundAmountMinor always exceeds
  // transferAmountMinor + platformFeeMinor regardless of combination,
  // rather than a dependent arbitrary.
  fundAmountMinor: number;
  transferAmountMinor: number;
  platformFeeMinor: number;
}

const transferOpArb: fc.Arbitrary<TransferOp> = fc.record({
  fundAmountMinor: fc.integer({ min: 1_000, max: 10_000_000 }),
  transferAmountMinor: fc.integer({ min: 1, max: 500 }),
  platformFeeMinor: fc.integer({ min: 0, max: 50 }),
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

  it('holds after any sequence mixing funding and transfer postings, with cache/ledger agreement checked throughout', async () => {
    const opArb: fc.Arbitrary<
      { kind: 'funding'; op: FundingOp } | { kind: 'transfer'; op: TransferOp }
    > = fc.oneof(
      fundingOpArb.map((op) => ({ kind: 'funding' as const, op })),
      transferOpArb.map((op) => ({ kind: 'transfer' as const, op })),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 8 }),
        async (ops) => {
          for (const entry of ops) {
            if (entry.kind === 'funding') {
              const identity = nextIdentity();
              const { walletId } = await seedUserWithWallet(ctx, identity);
              const reference = `cliqpay-invariant-mixed-${randomUUID()}`;
              const netAmount = Money.of(entry.op.netAmountMinor, 'NGN');
              const providerFee = Money.of(entry.op.feeMinor, 'NGN');

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
              await assertCacheMatchesLedger(ctx, walletId);
              continue;
            }

            const senderIdentity = nextIdentity();
            const recipientIdentity = nextIdentity();
            const { walletId: senderWalletId } = await seedUserWithWallet(
              ctx,
              senderIdentity,
            );
            const { walletId: recipientWalletId } = await seedUserWithWallet(
              ctx,
              recipientIdentity,
            );
            const fundReference = `cliqpay-invariant-mixed-fund-${randomUUID()}`;
            await ctx.ledgerService.createPendingFundingTransaction({
              reference: fundReference,
              provider: 'kora',
              providerReference: fundReference,
              amount: Money.of(entry.op.fundAmountMinor, 'NGN'),
              recipientWalletId: senderWalletId,
              metadata: { checkoutUrl: null, grossAmount: null },
            });
            const fundingResult = await ctx.ledgerService.postFunding({
              reference: fundReference,
              netAmount: Money.of(entry.op.fundAmountMinor, 'NGN'),
              providerFee: Money.zero('NGN'),
              providerStatus: 'success',
            });
            expect(fundingResult).not.toBeNull();

            const transferReference = `cliqpay-invariant-mixed-xfer-${randomUUID()}`;
            const transferResult = await ctx.ledgerService.postTransfer({
              reference: transferReference,
              senderWalletId,
              recipientWalletId,
              amount: Money.of(entry.op.transferAmountMinor, 'NGN'),
              platformFee: Money.of(entry.op.platformFeeMinor, 'NGN'),
            });
            expect(transferResult).toBeDefined();

            await assertInvariantHolds(ctx);
            await assertCacheMatchesLedger(ctx, senderWalletId);
            await assertCacheMatchesLedger(ctx, recipientWalletId);
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

  it('rejects UPDATE and DELETE against ledger_entries at the database level, not just by application convention', async () => {
    // L2 — CLAUDE.md calls ledger_entries append-only "non-negotiable," but
    // until the EnforceLedgerEntriesAppendOnly migration, nothing actually
    // stopped a raw UPDATE/DELETE from succeeding; only every code path
    // happening to never issue one. This proves the DB itself refuses,
    // independent of application code.
    const { walletId } = await seedUserWithWallet(ctx, {
      email: 'append-only@example.com',
      phone: '+2348022220099',
      username: 'append_only_user',
    });
    const reference = 'cliqpay-append-only-1';
    await ctx.ledgerService.createPendingFundingTransaction({
      reference,
      provider: 'kora',
      providerReference: reference,
      amount: Money.of(100_000n, 'NGN'),
      recipientWalletId: walletId,
      metadata: { checkoutUrl: null, grossAmount: null },
    });
    await ctx.ledgerService.postFunding({
      reference,
      netAmount: Money.of(100_000n, 'NGN'),
      providerFee: Money.zero('NGN'),
      providerStatus: 'success',
    });
    const entry = await ctx.ledgerEntryRepo.findOneByOrFail({
      accountId: walletId,
    });

    await expect(
      ctx.dataSource.query(
        `UPDATE ledger_entries SET amount = amount + 1 WHERE id = $1`,
        [entry.id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.dataSource.query(`DELETE FROM ledger_entries WHERE id = $1`, [
        entry.id,
      ]),
    ).rejects.toThrow(/append-only/);

    const unchanged = await ctx.ledgerEntryRepo.findOneByOrFail({
      id: entry.id,
    });
    expect(unchanged.amount).toBe(entry.amount);
  });
});
