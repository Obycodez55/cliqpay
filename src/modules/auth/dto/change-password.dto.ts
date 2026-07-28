import {
  IsBoolean,
  IsString,
  IsUUID,
  Length,
  MinLength,
} from 'class-validator';
import { IsNotCommonPassword } from '../internal/is-not-common-password.validator';

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @IsNotCommonPassword()
  newPassword: string;

  @IsUUID()
  challengeId: string;

  @IsString()
  @Length(6, 6)
  code: string;

  // No default and no @IsOptional — a missing value must fail validation
  // rather than silently mean "false" (same explicit design decision as
  // CompletePasswordResetDto/ConfirmChangeEmailDto).
  @IsBoolean()
  revokeOtherSessions: boolean;
}
