import { ApiProperty } from '@nestjs/swagger';
import { KycTier } from '../../users/users.service';

export const LIVENESS_RESULTS = [
  'passed',
  'failed',
  'pending',
  'not_requested',
] as const;
export type LivenessResult = (typeof LIVENESS_RESULTS)[number];

export class VerifyIdentityResponseDto {
  @ApiProperty({ enum: ['tier0', 'tier1', 'tier2', 'tier3'] })
  tier: KycTier;

  @ApiProperty()
  bvnVerified: boolean;

  @ApiProperty()
  ninVerified: boolean;

  @ApiProperty({ description: 'The stored liveness flag.' })
  livenessVerified: boolean;

  @ApiProperty({
    enum: LIVENESS_RESULTS,
    description:
      "This request's liveness outcome. 'pending' means the provider is still processing; poll GET /kyc/status. 'not_requested' means no liveness capture was sent.",
  })
  livenessResult: LivenessResult;
}
