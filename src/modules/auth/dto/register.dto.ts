import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotCommonPassword } from '../internal/is-not-common-password.validator';
import {
  IsNigerianMobile,
  normalizeNigerianMobile,
} from '../../../common/validation/phone';

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @Transform(lowercaseTrim)
  @IsEmail()
  @ApiProperty({ example: 'jane@example.com' })
  email: string;

  @IsString()
  @MinLength(8)
  @IsNotCommonPassword()
  @ApiProperty({ example: 'correct-horse-battery-staple', minLength: 8 })
  password: string;

  @IsString()
  @MaxLength(100)
  @ApiProperty({ example: 'Jane' })
  firstName: string;

  @IsString()
  @MaxLength(100)
  @ApiProperty({ example: 'Doe' })
  lastName: string;

  @Transform(lowercaseTrim)
  @Matches(/^[a-z0-9_]{3,20}$/, {
    message:
      'username must be 3-20 characters and contain only lowercase letters, numbers, or underscores',
  })
  @ApiProperty({
    example: 'jane_doe',
    description:
      'Lowercase letters, numbers, and underscores only, 3-20 characters',
  })
  username: string;

  @Transform(({ value }: { value: unknown }) => normalizeNigerianMobile(value))
  @IsNigerianMobile()
  @ApiProperty({
    example: '+2348012345678',
    description:
      'A Nigerian mobile number, in any common format; stored as E.164',
  })
  phone: string;
}
