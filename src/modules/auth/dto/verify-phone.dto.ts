import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class VerifyPhoneDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit numeric code' })
  code: string;
}
