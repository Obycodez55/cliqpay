import { IsNull, Repository } from 'typeorm';
import { Account } from '../../../src/modules/ledger/entities/account.entity';

// docs/architecture.md §4.3: float_ngn[kora] = Σ(user wallets) + fee_income
// + suspense. One shared definition so no spec can drift from it.
export async function assertInvariantHolds(
  accountRepo: Repository<Account>,
): Promise<void> {
  const float = await accountRepo.findOneByOrFail({
    role: 'float',
    provider: 'kora',
    currency: 'NGN',
  });
  const feeIncome = await accountRepo.findOneByOrFail({
    role: 'fee_income',
    provider: IsNull(),
    currency: 'NGN',
  });
  const suspense = await accountRepo.findOneByOrFail({
    role: 'suspense',
    provider: 'kora',
    currency: 'NGN',
  });
  const wallets = await accountRepo.findBy({
    role: 'user_wallet',
    currency: 'NGN',
  });
  const walletSum = wallets.reduce((sum, w) => sum + w.balance, 0n);

  expect(float.balance).toBe(walletSum + feeIncome.balance + suspense.balance);
}
