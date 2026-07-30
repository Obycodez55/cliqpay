import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Money } from '../../shared/primitives/money';
import { Account } from './entities/account.entity';
import {
  FundingTransactionMetadata,
  Transaction,
  TransactionProvider,
} from './entities/transaction.entity';

export interface CreatePendingFundingTransactionData {
  reference: string;
  provider: TransactionProvider;
  providerReference: string;
  amount: Money;
  recipientWalletId: string;
  metadata: FundingTransactionMetadata;
}

/**
 * The one exported surface of the ledger module — see
 * docs/architecture.md §10. `createUserWallet` and `getUserWallet` exist for
 * now; ledger-entry posting logic arrives with issue #13 — this module only
 * creates the `transactions` row for a funding attempt so far.
 */
@Injectable()
export class LedgerService {
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
}
