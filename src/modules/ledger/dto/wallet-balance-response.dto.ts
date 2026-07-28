import { Money } from '../../../shared/primitives/money';
import { Account } from '../entities/account.entity';

export interface WalletBalanceResponseDto {
  currency: string;
  balance: { amount: string; currency: string };
}

export function toWalletBalanceResponse(
  wallet: Account,
): WalletBalanceResponseDto {
  return {
    currency: wallet.currency,
    balance: Money.of(wallet.balance, wallet.currency).toJSON(),
  };
}
