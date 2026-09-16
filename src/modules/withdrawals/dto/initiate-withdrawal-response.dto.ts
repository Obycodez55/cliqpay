import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';

export class InitiateWithdrawalResponseDto {
  @ApiProperty()
  reference: string;

  @ApiProperty({ type: MoneyDto })
  amount: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  platformFee: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  providerFee: MoneyDto;

  // 'pending' is the only value issue #28 can ever return — the payout's
  // final outcome (completed/failed) only arrives on the webhook (#29).
  @ApiProperty({ enum: ['pending'] })
  status: 'pending';

  @ApiProperty()
  createdAt: string;
}
