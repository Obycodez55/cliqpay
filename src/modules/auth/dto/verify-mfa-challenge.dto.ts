import { IsString, IsUUID, Length } from 'class-validator';

export class VerifyMfaChallengeDto {
  @IsUUID()
  challengeId: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
