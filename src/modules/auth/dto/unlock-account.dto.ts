import { IsString, IsUUID, Length, Matches } from 'class-validator';

export class UnlockAccountDto {
  @IsUUID()
  challengeId: string;

  @IsString()
  @Length(6, 6)
  code: string;

  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  pin: string;
}
