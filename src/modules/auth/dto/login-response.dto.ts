import { ApiProperty } from '@nestjs/swagger';
import { TokenPairResponseDto } from './token-pair-response.dto';

export type MfaMethodKind = 'email' | 'totp';

export class LoginSuccessResponseDto extends TokenPairResponseDto {
  @ApiProperty({ example: false })
  mfaRequired: false;
}

export class LoginMfaRequiredResponseDto {
  @ApiProperty({ example: true })
  mfaRequired: true;

  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  challengeId: string;

  @ApiProperty({ enum: ['email', 'totp'] })
  method: MfaMethodKind;

  @ApiProperty({ example: '2026-07-28T19:15:00.000Z' })
  expiresAt: Date;
}

// A discriminated union, not always-tokens — see docs/architecture.md §3.8:
// login on an untrusted device must challenge before issuing anything.
// Two classes rather than one, so each branch is independently
// introspectable — see AuthController.login's @ApiExtraModels/oneOf.
export type LoginResponseDto =
  | LoginSuccessResponseDto
  | LoginMfaRequiredResponseDto;
