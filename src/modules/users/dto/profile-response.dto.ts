import { User } from '../entities/user.entity';

// Explicit shape, never the raw entity. No `mfaMethods` field — MFA
// enrollment is owned by `auth`'s MfaService, and `users` cannot depend on
// `auth` (would create the cycle ADR-0005 rules out) — see ADR-0005 for the
// full reasoning behind dropping it rather than forcing the dependency.
export interface ProfileResponseDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerifiedAt: Date | null;
  phone: string;
  phoneVerifiedAt: Date | null;
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
