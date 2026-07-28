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

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Matches(/^\+?[1-9]\d{6,14}$/, {
    message: 'phone must be a valid phone number',
  })
  @ApiProperty({ example: '+2348012345678', description: 'E.164 format' })
  phone: string;
}
