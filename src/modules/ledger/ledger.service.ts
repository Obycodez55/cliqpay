import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, In, LessThan } from 'typeorm';
import { runInTransaction } from '../../database/transaction.util';
import { Money } from '../../shared/primitives/money';
import { PaginatedResult } from '../../common/interfaces/paginated-result.interface';
import {
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from '../../common/pagination/cursor';
import {
  TransactionHistoryEntry,
  toTransactionHistoryEntry,
} from './dto/transaction-history-item.dto';
import { Account } from './entities/account.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import {
  FundingTransactionMetadata,
  Transaction,
  TransactionProvider,
} from './entities/transaction.entity';
import { InsufficientFundsException } from './internal/errors';

// Re-exported through the module's one door (this file) — `payments` needs
// the type for its active-(provider, currency)-pairs list (issue #15), and
// cross-module code only ever reaches ledger through LedgerService.
export type { TransactionProvider };

export interface CreatePendingFundingTransactionData {
  reference: string;
  provider: TransactionProvider;
  providerReference: string;
  amount: Money;
  recipientWalletId: string;
  metadata: FundingTransactionMetadata;
}

export interface PostFundingFacts {
  reference: string;
  netAmount: Money;
  providerFee: Money;
  providerStatus: 'success' | 'failed';
}

export interface PostFundingResult {
  userId: string;
  netAmount: Money;
  reference: string;
}

// Structurally narrow rather than the full `Transaction` entity — `payments`
// (the only caller) needs the reference to poll on and the currency to
// build zero-amount facts for a `failed` outcome, nothing else (ADR-0008).
export interface StaleFundingTransaction {
  reference: string;
  currency: string;
}

export interface TransactionHistoryPagination {
  cursor?: string;
  limit: number;
}

// Only the fields that define the operation (ADR-0010) — never headers,
// timestamps, or display-only fields, or a legitimate retry would spuriously
// diverge. `counterpartyWalletId` is omitted by callers that have no
// counterparty concept (funding always credits the caller's own wallet).
export interface TransactionFingerprint {
  amount: bigint;
  currency: string;
  counterpartyWalletId?: string;
}

export type IdempotentReplay =
  | { outcome: 'none' }
  | { outcome: 'match'; transaction: Transaction }
  | { outcome: 'foreign' }
  | { outcome: 'diverged' };

export interface PostTransferParams {
  reference: string;
  senderWalletId: string;
  recipientWalletId: string;
  amount: Money;
  platformFee: Money;
}

export interface PostTransferResult {
  transactionId: string;
  reference: string;
  senderUserId: string;
  recipientUserId: string;
  amount: Money;
  platformFee: Money;
  createdAt: Date;
}

/**
 * The one exported surface of the ledger module — see docs/architecture.md
 * §10.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Takes the caller's own EntityManager rather than an injected repository
   * — the wallet must be created in the same DB transaction as whatever
   * else the caller is doing (e.g. auth's User insert on registration), so
   * both commit or roll back together.
   */
  async createUserWallet(
    manager: EntityManager,
    userId: string,
    currency: string,
  ): Promise<Account> {
    const repo = manager.getRepository(Account);
    const wallet = repo.create({
      userId,
      type: 'liability',
      role: 'user_wallet',
      provider: null,
      currency,
      balance: Money.zero(currency).amount,
    });
    return repo.save(wallet);
  }

  // Every user gets exactly one `user_wallet` account at registration (see
  // AuthService.register) — `findOneByOrFail` reflects that this can't
  // legitimately be missing for an authenticated user, not a lookup that's
  // expected to sometimes miss.
  async getUserWallet(userId: string): Promise<Account> {
    return this.dataSource
      .getRepository(Account)
      .findOneByOrFail({ userId, role: 'user_wallet' });
  }

  // Idempotency lookup for client-initiated money movements (§3.4, ADR-0010)
  // — shared by every such endpoint (funding today, transfers next) so the
  // cross-user and fingerprint rules are decided once. A reference that
  // exists but belongs to someone else must never replay or leak anything
  // about the other transaction (defect 1) — 'foreign' stops that at the
  // lookup, before the caller can build a response from it. A reference
  // reused with different meaningful parameters must not silently replay
  // the old result under a new request (defect 2) — 'diverged' stops that.
  async checkIdempotentReplay(
    reference: string,
    callerId: string,
    fingerprint: TransactionFingerprint,
  ): Promise<IdempotentReplay> {
    const transaction = await this.dataSource
      .getRepository(Transaction)
      .findOneBy({ reference });
    if (!transaction) {
      return { outcome: 'none' };
    }

    if (!(await this.transactionBelongsToUser(transaction, callerId))) {
      return { outcome: 'foreign' };
    }

    const fingerprintMatches =
      transaction.amount === fingerprint.amount &&
      transaction.currency === fingerprint.currency &&
      (fingerprint.counterpartyWalletId === undefined ||
        transaction.recipientWalletId === fingerprint.counterpartyWalletId);

    return fingerprintMatches
      ? { outcome: 'match', transaction }
      : { outcome: 'diverged' };
  }

  // `transactions` has no user_id column (ADR-0010 rejected adding one) —
  // participants live only in the denormalized sender/recipient wallet
  // columns, so ownership resolves by checking whether either wallet on the
  // row is one of the caller's own accounts.
  private async transactionBelongsToUser(
    transaction: Transaction,
    userId: string,
  ): Promise<boolean> {
    const walletIds = [
      transaction.senderWalletId,
      transaction.recipientWalletId,
    ].filter((id): id is string => id !== null);
    if (walletIds.length === 0) {
      return false;
    }
    const count = await this.dataSource
      .getRepository(Account)
      .count({ where: { id: In(walletIds), userId } });
    return count > 0;
  }

  // `type`/`status` are fixed to 'funding'/'pending' — this is the only
  // transaction-creation path that exists yet (see the class doc). No
  // ledger entries are posted here; that arrives with issue #13, once
  // something has actually succeeded.
  async createPendingFundingTransaction(
    data: CreatePendingFundingTransactionData,
  ): Promise<Transaction> {
    const repo = this.dataSource.getRepository(Transaction);
    const transaction = repo.create({
      reference: data.reference,
      provider: data.provider,
      providerReference: data.providerReference,
      type: 'funding',
      status: 'pending',
      reversesTransactionId: null,
      amount: data.amount.amount,
      currency: data.amount.currency,
      senderWalletId: null,
      recipientWalletId: data.recipientWalletId,
      metadata: data.metadata,
    });
    return repo.save(transaction);
  }

  // Narrowly typed to funding's one metadata field rather than a generic
  // metadata patch, since that's the only write this shape needs today.
  async setFundingCheckoutUrl(
    reference: string,
    checkoutUrl: string,
  ): Promise<void> {
    await this.mergeTransactionMetadata(reference, { checkoutUrl });
  }

  // A plain `.update({ metadata: patch })` overwrites the whole jsonb
  // column — harmless while `checkoutUrl` was the only field, a real
  // data-loss risk now that `grossAmount` (set later, at completion) also
  // lives there: whichever write lands second would erase the first.
  // Postgres's `||` does an actual merge instead. Accepts an
  // EntityManager so a caller already inside a DB transaction (e.g.
  // postFundingEntries) can include this write in it, rather than
  // defaulting to a separate implicit transaction via `this.dataSource`.
  private async mergeTransactionMetadata(
    reference: string,
    patch: Record<string, unknown>,
    manager: EntityManager | DataSource = this.dataSource,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(Transaction)
      .set({ metadata: () => `metadata || :patch::jsonb` })
      .where('reference = :reference', { reference })
      .setParameter('patch', JSON.stringify(patch))
      .execute();
  }

  // The provider call failed after the pending row was already inserted
  // (see PaymentsService.fundWallet) — marked `failed` rather than deleted,
  // consistent with transactions being a record of what was attempted, not
  // just what succeeded (unlike `ledger_entries`, nothing here has posted
  // yet, so this isn't a mutation of settled history).
  async markFundingTransactionFailed(reference: string): Promise<void> {
    await this.dataSource
      .getRepository(Transaction)
      .update({ reference }, { status: 'failed' });
  }

  // Feeds the self-verify poll job (issue #14) — `payments` decides the
  // staleness threshold and passes it in as `olderThan`; this is a plain
  // read of `transactions`, still ledger's table, so the query lives here
  // rather than being raw-queried from `payments`.
  async findStaleFundingTransactions(
    olderThan: Date,
  ): Promise<StaleFundingTransaction[]> {
    const transactions = await this.dataSource.getRepository(Transaction).find({
      where: {
        status: 'pending',
        provider: 'kora',
        type: 'funding',
        createdAt: LessThan(olderThan),
      },
      select: { reference: true, currency: true },
    });
    return transactions.map((transaction) => ({
      reference: transaction.reference,
      currency: transaction.currency,
    }));
  }

  // Feeds the external reconciliation job (issue #15) — a plain read of
  // `float_<ccy>`'s cached balance, ledger's own table, so `payments` gets
  // just the Money it needs to compare against the provider's reported
  // balance rather than the full Account entity (same narrowing as
  // StaleFundingTransaction above).
  async getFloatBalance(
    provider: TransactionProvider,
    currency: string,
  ): Promise<Money> {
    const account = await this.dataSource
      .getRepository(Account)
      .findOneByOrFail({
        role: 'float',
        provider,
        currency,
      });
    return Money.of(account.balance, account.currency);
  }

  // Serves GET /wallet/transactions (issue #16). Reads ledger_entries joined
  // to transactions — per §5, ledger_entries is the source of truth for who
  // was involved, not transactions' denormalized sender/recipient columns —
  // filtered to the caller's own account. Newest-first, paginated on
  // (createdAt, id) rather than OFFSET since this table is append-only and
  // high-write (docs/conventions.md).
  async getTransactionHistory(
    walletId: string,
    pagination: TransactionHistoryPagination,
  ): Promise<PaginatedResult<TransactionHistoryEntry>> {
    const cursor = pagination.cursor
      ? decodeCreatedAtIdCursor(pagination.cursor)
      : null;

    const query = this.dataSource
      .getRepository(LedgerEntry)
      .createQueryBuilder('entry')
      .innerJoinAndSelect('entry.transaction', 'transaction')
      // Postgres's own text form of the timestamp, not the JS `Date` the
      // entity gets mapped to — `Date` only holds millisecond precision, so
      // round-tripping the cursor through `.toISOString()` silently drops
      // rows whose createdAt shares a millisecond with the page boundary
      // (routine here: postFundingEntries batch-inserts 4 entries in one
      // statement, so they often land at the same or an adjacent
      // microsecond). Comparing on Postgres's own text preserves full
      // precision on both sides of the cursor round trip.
      .addSelect('"entry"."created_at"::text', 'raw_created_at')
      .where('entry.accountId = :walletId', { walletId })
      .orderBy('entry.createdAt', 'DESC')
      .addOrderBy('entry.id', 'DESC')
      .take(pagination.limit + 1);

    if (cursor) {
      query.andWhere(
        '(entry.createdAt, entry.id) < (:cursorCreatedAt::timestamptz, :cursorId::uuid)',
        { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
      );
    }

    const { entities, raw } = await query.getRawAndEntities<{
      raw_created_at: string;
    }>();
    const hasMore = entities.length > pagination.limit;
    const page = hasMore ? entities.slice(0, pagination.limit) : entities;
    const lastRaw = hasMore ? raw[pagination.limit - 1] : raw[raw.length - 1];

    const counterpartyWalletIds = [
      ...new Set(
        page
          .filter((entry) => entry.transaction.type === 'p2p_transfer')
          .map((entry) =>
            entry.transaction.senderWalletId === walletId
              ? entry.transaction.recipientWalletId
              : entry.transaction.senderWalletId,
          )
          .filter((id): id is string => id !== null),
      ),
    ];
    const counterpartyAccounts = counterpartyWalletIds.length
      ? await this.dataSource.getRepository(Account).find({
          where: { id: In(counterpartyWalletIds) },
          select: { id: true, userId: true },
        })
      : [];
    const counterpartyUserIdByWalletId = new Map(
      counterpartyAccounts.map((account) => [account.id, account.userId]),
    );

    return {
      items: page.map((entry) =>
        toTransactionHistoryEntry(
          entry,
          walletId,
          counterpartyUserIdByWalletId,
        ),
      ),
      nextCursor:
        hasMore && lastRaw
          ? encodeCreatedAtIdCursor({
              createdAt: lastRaw.raw_created_at,
              id: page[page.length - 1].id,
            })
          : null,
    };
  }

  /**
   * The single place funding ledger entries are ever posted (docs/adr/0008)
   * — `payments`' webhook handler and #14's poll job both call this with
   * provider facts; this decides what they post to. Idempotent: the
   * `pending` -> terminal transition happens via one atomic UPDATE guarded
   * on current status, so a duplicate delivery (this called twice for the
   * same reference) finds 0 rows affected on the second call and returns
   * null without touching ledger_entries or accounts again.
   */
  async postFunding(
    facts: PostFundingFacts,
  ): Promise<PostFundingResult | null> {
    return runInTransaction(this.dataSource, async (manager) => {
      // `amount` is immutable after creation (only `status`/`metadata`
      // change post-creation — see createPendingFundingTransaction and the
      // methods around it), so reading it here ahead of the guarded UPDATE
      // below is safe: it can't race a concurrent writer.
      const transaction = await manager
        .getRepository(Transaction)
        .findOneBy({ reference: facts.reference });
      if (!transaction) {
        this.logger.error(
          `postFunding: no transaction found for reference "${facts.reference}"`,
        );
        return null;
      }

      // The provider's reported amount must match what was actually
      // requested at initiation — crediting whatever a webhook/poll result
      // claims, with no cross-check against our own record, means a
      // manipulated or buggy provider response can credit an arbitrary
      // amount. A mismatch fails the transaction rather than posting an
      // unverified one.
      const amountMismatch =
        facts.providerStatus === 'success' &&
        facts.netAmount.amount !== transaction.amount;
      if (amountMismatch) {
        this.logger.error(
          `postFunding: provider-reported amount (${facts.netAmount.toDecimalString()}) does not match the requested amount (${Money.of(transaction.amount, transaction.currency).toDecimalString()}) for reference "${facts.reference}" — marking failed instead of crediting an unverified amount`,
        );
      }
      const nextStatus =
        facts.providerStatus === 'success' && !amountMismatch
          ? 'completed'
          : 'failed';

      const updateResult = await manager
        .createQueryBuilder()
        .update(Transaction)
        .set({ status: nextStatus })
        .where('reference = :reference', { reference: facts.reference })
        .andWhere('status = :pending', { pending: 'pending' })
        .execute();
      if (!updateResult.affected) {
        this.logger.debug(
          `postFunding: no pending transaction for reference "${facts.reference}" — duplicate delivery or already resolved`,
        );
        return null;
      }

      if (nextStatus !== 'completed') {
        return null;
      }

      return this.postFundingEntries(manager, transaction, facts);
    });
  }

  // Split out from postFunding purely so the "am I done" early-returns above
  // stay flat — this is the part that actually touches ledger_entries and
  // accounts, once the atomic status transition has already proven this is
  // the one delivery that gets to post.
  private async postFundingEntries(
    manager: EntityManager,
    transaction: Transaction,
    facts: PostFundingFacts,
  ): Promise<PostFundingResult> {
    const accountRepo = manager.getRepository(Account);

    // Lock ordering (CLAUDE.md): every multi-row wallet lock is acquired by
    // account_id ascending, regardless of debit/credit direction — one
    // query, ORDER BY id ASC, FOR UPDATE, so concurrent postings of
    // different transactions touching overlapping system accounts can never
    // deadlock against each other.
    const accounts = await accountRepo
      .createQueryBuilder('account')
      .where(
        new Brackets((qb) => {
          qb.where('account.id = :walletId', {
            walletId: transaction.recipientWalletId,
          })
            .orWhere(
              '(account.role = :float AND account.provider = :provider AND account.currency = :currency AND account.userId IS NULL)',
              {
                float: 'float',
                provider: transaction.provider,
                currency: transaction.currency,
              },
            )
            .orWhere(
              '(account.role = :feeExpense AND account.provider = :provider AND account.currency = :currency AND account.userId IS NULL)',
              {
                feeExpense: 'fee_expense',
                provider: transaction.provider,
                currency: transaction.currency,
              },
            )
            .orWhere(
              '(account.role = :feeRecovery AND account.provider = :provider AND account.currency = :currency AND account.userId IS NULL)',
              {
                feeRecovery: 'fee_recovery',
                provider: transaction.provider,
                currency: transaction.currency,
              },
            );
        }),
      )
      .orderBy('account.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();

    const wallet = accounts.find((a) => a.id === transaction.recipientWalletId);
    const float = accounts.find((a) => a.role === 'float');
    const feeExpense = accounts.find((a) => a.role === 'fee_expense');
    const feeRecovery = accounts.find((a) => a.role === 'fee_recovery');
    if (!wallet || !float || !feeExpense || !feeRecovery) {
      throw new Error(
        `postFunding: missing one of wallet/float/fee_expense/fee_recovery accounts for transaction "${transaction.reference}"`,
      );
    }

    // Routed through Money.add(), not raw bigint arithmetic — CLAUDE.md's
    // "all money math goes through Money" rule, and it's not just style
    // here: .add() asserts matching currencies, so a facts/account currency
    // mismatch throws instead of silently corrupting a balance.
    const newWalletBalance = Money.of(wallet.balance, wallet.currency).add(
      facts.netAmount,
    );
    const newFloatBalance = Money.of(float.balance, float.currency).add(
      facts.netAmount,
    );
    const newFeeExpenseBalance = Money.of(
      feeExpense.balance,
      feeExpense.currency,
    ).add(facts.providerFee);
    const newFeeRecoveryBalance = Money.of(
      feeRecovery.balance,
      feeRecovery.currency,
    ).add(facts.providerFee);

    wallet.balance = newWalletBalance.amount;
    float.balance = newFloatBalance.amount;
    feeExpense.balance = newFeeExpenseBalance.amount;
    feeRecovery.balance = newFeeRecoveryBalance.amount;
    // §2: the cache is written in the same DB transaction, from the same
    // computation that produces the ledger entries below — one place.
    await accountRepo.save([wallet, float, feeExpense, feeRecovery]);

    const entryRepo = manager.getRepository(LedgerEntry);
    await entryRepo.save([
      entryRepo.create({
        transactionId: transaction.id,
        accountId: float.id,
        direction: 'debit',
        amount: facts.netAmount.amount,
        runningBalance: newFloatBalance.amount,
      }),
      entryRepo.create({
        transactionId: transaction.id,
        accountId: wallet.id,
        direction: 'credit',
        amount: facts.netAmount.amount,
        runningBalance: newWalletBalance.amount,
      }),
      entryRepo.create({
        transactionId: transaction.id,
        accountId: feeExpense.id,
        direction: 'debit',
        amount: facts.providerFee.amount,
        runningBalance: newFeeExpenseBalance.amount,
      }),
      entryRepo.create({
        transactionId: transaction.id,
        accountId: feeRecovery.id,
        direction: 'credit',
        amount: facts.providerFee.amount,
        runningBalance: newFeeRecoveryBalance.amount,
      }),
    ]);

    // §4.2: funding metadata records the gross amount (what the customer
    // paid — net + provider fee), since `transactions.amount`/
    // `ledger_entries` only carry the net (credited) side. Same DB
    // transaction as the entries above, not a separate write.
    await this.mergeTransactionMetadata(
      transaction.reference,
      { grossAmount: facts.netAmount.add(facts.providerFee).toJSON() },
      manager,
    );

    return {
      userId: wallet.userId!,
      netAmount: facts.netAmount,
      reference: transaction.reference,
    };
  }

  /**
   * The single place P2P transfer ledger entries are ever posted
   * (ADR-0011) — `transfers` owns eligibility, PIN verification, and
   * idempotency; this only knows how to move money between two wallets
   * plus the platform fee. Posts directly to `completed` in one DB
   * transaction — unlike funding, nothing external happens between
   * initiation and completion, so there's no pending row worth leaving
   * behind. A duplicate `reference` fails on the unique constraint here;
   * the caller handles that race the same way PaymentsService.fundWallet
   * handles funding's.
   */
  async postTransfer(params: PostTransferParams): Promise<PostTransferResult> {
    return runInTransaction(this.dataSource, (manager) =>
      this.postTransferEntries(manager, params),
    );
  }

  /**
   * Public sibling of postTransfer for a caller that already has its own
   * open transaction and needs the posting to be part of it — paying a
   * money request must post the transfer and flip the request row to
   * `paid` atomically, so MoneyRequestsService.payRequest opens the one
   * transaction and calls this instead of postTransfer (same pattern as
   * mergeTransactionMetadata's manager-accepting form).
   */
  async postTransferWithinTransaction(
    manager: EntityManager,
    params: PostTransferParams,
  ): Promise<PostTransferResult> {
    return this.postTransferEntries(manager, params);
  }

  // Deliberately not sharing postFundingEntries' lock query — that one locks
  // a fixed set of provider-scoped system accounts alongside one wallet;
  // this locks two user wallets and, only when the fee is non-zero, one
  // provider-agnostic system account. Same Brackets/ORDER BY id ASC/
  // pessimistic_write idea, but little of the actual query would be shared
  // between the two, so this stays its own inline query rather than forcing
  // an abstraction across them (see transaction.util.ts's runInTransaction
  // comment, which anticipated this call site).
  private async postTransferEntries(
    manager: EntityManager,
    params: PostTransferParams,
  ): Promise<PostTransferResult> {
    const accountRepo = manager.getRepository(Account);
    const hasFee = params.platformFee.isPositive();

    const accounts = await accountRepo
      .createQueryBuilder('account')
      .where(
        new Brackets((qb) => {
          qb.where('account.id IN (:...walletIds)', {
            walletIds: [params.senderWalletId, params.recipientWalletId],
          });
          if (hasFee) {
            qb.orWhere(
              '(account.role = :feeIncome AND account.provider IS NULL AND account.currency = :currency AND account.userId IS NULL)',
              { feeIncome: 'fee_income', currency: params.amount.currency },
            );
          }
        }),
      )
      .orderBy('account.id', 'ASC')
      .setLock('pessimistic_write')
      .getMany();

    const sender = accounts.find((a) => a.id === params.senderWalletId);
    const recipient = accounts.find((a) => a.id === params.recipientWalletId);
    const feeIncome = hasFee
      ? accounts.find((a) => a.role === 'fee_income')
      : undefined;
    if (!sender || !recipient || (hasFee && !feeIncome)) {
      throw new Error(
        `postTransfer: missing one of sender/recipient/fee_income accounts for reference "${params.reference}"`,
      );
    }

    const debitAmount = params.amount.add(params.platformFee);
    // Balance is checked only after the accounts above are locked, never
    // before (CLAUDE.md) — checking first would let a concurrent transfer
    // draining the same sender pass this check and then invalidate it
    // before the debit lands (check-then-lock is a TOCTOU race).
    if (Money.of(sender.balance, sender.currency).lessThan(debitAmount)) {
      throw new InsufficientFundsException();
    }

    // Inserted only now, after the accounts above are already locked by
    // this transaction — sender_wallet_id/recipient_wallet_id are real FK
    // columns (CLAUDE.md's same-module-FK rule), and Postgres validates a
    // new FK reference by taking its own lock on the referenced accounts
    // row, in column order (sender, then recipient), independent of and
    // earlier than any lock this method takes explicitly. Inserting before
    // the ordered SELECT ... FOR UPDATE above would let that FK-check lock
    // land in the wrong order between two opposite-direction transfers —
    // reproduced directly as a real Postgres deadlock — so the explicit
    // ascending-id lock must be acquired first; the FK check then just
    // re-confirms a lock this transaction already holds.
    const transactionRepo = manager.getRepository(Transaction);
    const transaction = await transactionRepo.save(
      transactionRepo.create({
        reference: params.reference,
        provider: null,
        providerReference: null,
        type: 'p2p_transfer',
        status: 'completed',
        reversesTransactionId: null,
        amount: params.amount.amount,
        currency: params.amount.currency,
        senderWalletId: params.senderWalletId,
        recipientWalletId: params.recipientWalletId,
        metadata: { platformFee: params.platformFee.toJSON() },
      }),
    );

    const newSenderBalance = Money.of(sender.balance, sender.currency).subtract(
      debitAmount,
    );
    const newRecipientBalance = Money.of(
      recipient.balance,
      recipient.currency,
    ).add(params.amount);

    sender.balance = newSenderBalance.amount;
    recipient.balance = newRecipientBalance.amount;
    const accountsToSave = [sender, recipient];

    let newFeeIncomeBalance: Money | undefined;
    if (hasFee && feeIncome) {
      newFeeIncomeBalance = Money.of(feeIncome.balance, feeIncome.currency).add(
        params.platformFee,
      );
      feeIncome.balance = newFeeIncomeBalance.amount;
      accountsToSave.push(feeIncome);
    }
    // §2: the cache is written in the same DB transaction, from the same
    // computation that produces the ledger entries below — one place.
    await accountRepo.save(accountsToSave);

    const entryRepo = manager.getRepository(LedgerEntry);
    const entries = [
      entryRepo.create({
        transactionId: transaction.id,
        accountId: sender.id,
        direction: 'debit',
        amount: debitAmount.amount,
        runningBalance: newSenderBalance.amount,
      }),
      entryRepo.create({
        transactionId: transaction.id,
        accountId: recipient.id,
        direction: 'credit',
        amount: params.amount.amount,
        runningBalance: newRecipientBalance.amount,
      }),
    ];
    // §4.2: a zero-fee transfer is a balanced two-leg posting, not a
    // three-leg one with a zero-amount row — ledger_entries is guaranteed
    // to grow without bound, and a permanent no-information row on every
    // transfer is both storage and a misleading statement line.
    if (hasFee && feeIncome && newFeeIncomeBalance) {
      entries.push(
        entryRepo.create({
          transactionId: transaction.id,
          accountId: feeIncome.id,
          direction: 'credit',
          amount: params.platformFee.amount,
          runningBalance: newFeeIncomeBalance.amount,
        }),
      );
    }
    await entryRepo.save(entries);

    return {
      transactionId: transaction.id,
      reference: transaction.reference,
      senderUserId: sender.userId!,
      recipientUserId: recipient.userId!,
      amount: params.amount,
      platformFee: params.platformFee,
      createdAt: transaction.createdAt,
    };
  }
}
