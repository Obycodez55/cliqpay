import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { Money } from '../../../shared/primitives/money';
import { Account } from '../entities/account.entity';

export class WalletBalanceResponseDto {
  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ type: MoneyDto })
  balance: MoneyDto;
}

export function toWalletBalanceResponse(
  wallet: Account,
): WalletBalanceResponseDto {
  return {
    currency: wallet.currency,
    balance: Money.of(wallet.balance, wallet.currency).toJSON(),
  };
}
