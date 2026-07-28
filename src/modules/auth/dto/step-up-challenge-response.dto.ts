import { ApiProperty } from '@nestjs/swagger';
import { MfaMethodKind } from './login-response.dto';

// Same shape as LoginMfaRequiredResponseDto — a step-up challenge is the
// same MfaChallenge machinery, just triggered explicitly instead of as a
// login fork.
export class StepUpChallengeResponseDto {
  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  challengeId: string;

  @ApiProperty({ enum: ['email', 'totp'] })
  method: MfaMethodKind;

  @ApiProperty({ example: '2026-07-28T19:15:00.000Z' })
  expiresAt: Date;
}
