import { IsString, MaxLength } from 'class-validator';

export class SelfLockTokenDto {
  @IsString()
  @MaxLength(256)
  token: string;
}
