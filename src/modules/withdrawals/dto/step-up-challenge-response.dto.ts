import { ApiProperty } from '@nestjs/swagger';

// Same shape as auth's own StepUpChallengeResponseDto — duplicated rather
// than imported because a module's dto/ files aren't a cross-module entry
// point (only <name>.service.ts/<name>.module.ts are, per
// docs/architecture.md §10 and this repo's eslint-plugin-boundaries config).
// AuthService.initiateStepUp returns this same shape structurally.
export class StepUpChallengeResponseDto {
  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  challengeId: string;

  @ApiProperty({ enum: ['email', 'totp'] })
  method: 'email' | 'totp';

  @ApiProperty({ example: '2026-08-16T19:15:00.000Z' })
  expiresAt: Date;
}
