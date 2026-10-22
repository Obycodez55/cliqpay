import { ApiProperty } from '@nestjs/swagger';
import { KycTier } from '../../users/users.service';

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
    description:
      "Today's remaining daily debit allowance, in minor units. Always 0 until limit enforcement is wired up.",
  })
  dailyAllowanceRemainingMinor: number;
}
