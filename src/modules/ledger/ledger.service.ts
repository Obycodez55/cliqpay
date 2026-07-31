import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, LessThan } from 'typeorm';
import { runInTransaction } from '../../database/transaction.util';
import { Money } from '../../shared/primitives/money';
import { Account } from './entities/account.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import {
  FundingTransactionMetadata,
  Transaction,
  TransactionProvider,
} from './entities/transaction.entity';

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
}

// Structurally narrow rather than the full `Transaction` entity — `payments`
// (the only caller) needs the reference to poll on and the currency to
// build zero-amount facts for a `failed` outcome, nothing else (ADR-0008).
export interface StaleFundingTransaction {
  reference: string;
  currency: string;
}

/**
 * The one exported surface of the ledger module — see
 * docs/architecture.md §10. `createUserWallet` and `getUserWallet` exist for
 * now; ledger-entry posting logic arrives with issue #13 — this module only
 * creates the `transactions` row for a funding attempt so far.
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

  // Idempotency lookup for client-initiated money movements (§3.4) — a
  // repeat call carrying a `reference` already seen returns the existing
  // row's result instead of creating a second one.
  async findTransactionByReference(
    reference: string,
  ): Promise<Transaction | null> {
    return this.dataSource.getRepository(Transaction).findOneBy({
      reference,
    });
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

  // Called once the provider call `createPendingFundingTransaction` gated
  // has actually returned — see PaymentsService.fundWallet. Narrowly typed
  // to funding's one metadata field rather than a generic metadata patch,
  // since that's the only write this shape needs today.
  async setFundingCheckoutUrl(
    reference: string,
    checkoutUrl: string,
  ): Promise<void> {
    await this.dataSource
      .getRepository(Transaction)
      .update({ reference }, { metadata: { checkoutUrl } });
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
      const nextStatus =
        facts.providerStatus === 'success' ? 'completed' : 'failed';

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

      const transaction = await manager
        .getRepository(Transaction)
        .findOneByOrFail({ reference: facts.reference });

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

    return { userId: wallet.userId!, netAmount: facts.netAmount };
  }
}
