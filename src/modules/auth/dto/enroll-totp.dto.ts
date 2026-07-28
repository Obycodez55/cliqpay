import { IsString, IsUUID, Length } from 'class-validator';

export class EnrollTotpDto {
  @IsUUID()
  challengeId: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
