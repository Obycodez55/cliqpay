import { Transform } from 'class-transformer';
import { IsEmail, IsString } from 'class-validator';

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class LoginDto {
  @Transform(lowercaseTrim)
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
