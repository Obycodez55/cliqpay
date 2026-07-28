import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsUUID, Length } from 'class-validator';

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class ChangeEmailDto {
  @Transform(lowercaseTrim)
  @IsEmail()
  newEmail: string;

  @IsUUID()
  challengeId: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
