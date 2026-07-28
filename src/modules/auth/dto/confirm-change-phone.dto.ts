import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

export class ConfirmChangePhoneDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  // No default and no @IsOptional — a missing value must fail validation
  // rather than silently mean "false" (same explicit design decision as
  // ConfirmChangeEmailDto).
  @IsBoolean()
  revokeOtherSessions: boolean;
}
