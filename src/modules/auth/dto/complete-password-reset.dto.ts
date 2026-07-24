import { IsBoolean, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { IsNotCommonPassword } from '../internal/is-not-common-password.validator';

export class CompletePasswordResetDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @MinLength(8)
  @IsNotCommonPassword()
  newPassword: string;

  // No default and no @IsOptional — a missing value must fail validation
  // rather than silently mean "false" (explicit design decision, see
  // issue #7).
  @IsBoolean()
  revokeOtherSessions: boolean;
}
