import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Money } from '../../shared/primitives/money';
import { Account } from './entities/account.entity';

/**
 * The one exported surface of the ledger module — see
 * docs/architecture.md §10. `createUserWallet` and `getUserWallet` exist for
 * now; posting logic (transactions, ledger_entries) arrives with the funding
 * module in Phase 2, not ahead of it.
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
}
