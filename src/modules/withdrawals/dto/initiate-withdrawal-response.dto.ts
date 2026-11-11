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

  // The payout's final outcome (completed/failed) only arrives on the
  // webhook. 'under_review' means the payout has not been sent yet.
  @ApiProperty({ enum: ['pending', 'under_review'] })
  status: 'pending' | 'under_review';

  @ApiProperty({ required: false })
  message?: string;

  @ApiProperty()
  createdAt: string;
}
