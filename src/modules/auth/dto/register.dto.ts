import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsNotCommonPassword } from '../internal/is-not-common-password.validator';

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @Transform(lowercaseTrim)
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @IsNotCommonPassword()
  password: string;

  @IsString()
  @MaxLength(100)
  firstName: string;

  @IsString()
  @MaxLength(100)
  lastName: string;

  @Transform(lowercaseTrim)
  @Matches(/^[a-z0-9_]{3,20}$/, {
    message:
      'username must be 3-20 characters and contain only lowercase letters, numbers, or underscores',
  })
  username: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Matches(/^\+?[1-9]\d{6,14}$/, {
    message: 'phone must be a valid phone number',
  })
  phone: string;
}
