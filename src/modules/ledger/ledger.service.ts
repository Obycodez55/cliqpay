import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Money } from '../../shared/primitives/money';
import { Account } from './entities/account.entity';

/**
 * The one exported surface of the ledger module — see
 * docs/architecture.md §10. Only `createUserWallet` exists for now; posting
 * logic (transactions, ledger_entries) arrives with the funding module in
 * Phase 2, not ahead of it.
 */
@Injectable()
export class LedgerService {
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
}
