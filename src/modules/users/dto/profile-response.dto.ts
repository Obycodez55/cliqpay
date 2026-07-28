import { ApiProperty } from '@nestjs/swagger';
import { User } from '../entities/user.entity';

// Explicit shape, never the raw entity. No `mfaMethods` field — MFA
// enrollment is owned by `auth`'s MfaService, and `users` cannot depend on
// `auth` (would create the cycle ADR-0005 rules out) — see ADR-0005 for the
// full reasoning behind dropping it rather than forcing the dependency.
export class ProfileResponseDto {
  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  id: string;

  @ApiProperty({ example: 'Jane' })
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  lastName: string;

  @ApiProperty({ example: 'jane@example.com' })
  email: string;

  @ApiProperty({ example: '2026-07-28T19:15:00.000Z', nullable: true })
  emailVerifiedAt: Date | null;

  @ApiProperty({ example: '+2348012345678' })
  phone: string;

  @ApiProperty({ example: '2026-07-28T19:15:00.000Z', nullable: true })
  phoneVerifiedAt: Date | null;

  @ApiProperty({ example: 'jane_doe' })
  username: string;
}

export function toProfileResponse(user: User): ProfileResponseDto {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt,
    phone: user.phone,
    phoneVerifiedAt: user.phoneVerifiedAt,
    username: user.username,
  };
}
