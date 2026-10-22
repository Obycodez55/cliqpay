import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { KycTier } from '../../users/users.service';

type MoneyResponse = { amount: string; currency: string };

export class KycStatusResponseDto {
  @ApiProperty({ enum: ['tier0', 'tier1', 'tier2', 'tier3'] })
  tier: KycTier;

  @ApiProperty()
  bvnVerified: boolean;

  @ApiProperty()
  ninVerified: boolean;

  @ApiProperty()
  livenessVerified: boolean;

  @ApiProperty({
    description: 'A liveness check is submitted and awaiting its result.',
  })
  livenessPending: boolean;

  @ApiProperty({
    type: MoneyDto,
    description: "The tier's daily debit limit (transfers and withdrawals).",
  })
  dailyDebitLimit: MoneyResponse;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: "The tier's wallet balance cap; null means no cap.",
  })
  balanceCap: MoneyResponse | null;
}
