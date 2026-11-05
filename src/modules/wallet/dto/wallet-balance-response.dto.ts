import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { Money } from '../../../shared/primitives/money';

export class WalletBalanceResponseDto {
  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ type: MoneyDto })
  balance: MoneyDto;
}

export function toWalletBalanceResponse(wallet: {
  currency: string;
  balance: bigint;
}): WalletBalanceResponseDto {
  return {
    currency: wallet.currency,
    balance: Money.of(wallet.balance, wallet.currency).toJSON(),
  };
}
