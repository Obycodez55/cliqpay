import { ApiProperty } from '@nestjs/swagger';
import { KycTier } from '../../users/users.service';

export class VerifyBvnResponseDto {
  @ApiProperty({ enum: ['tier0', 'tier1', 'tier2', 'tier3'] })
  tier: KycTier;

  @ApiProperty()
  bvnVerified: boolean;

  @ApiProperty()
  ninVerified: boolean;

  @ApiProperty()
  livenessVerified: boolean;
}
