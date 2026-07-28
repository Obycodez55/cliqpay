import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  // Same format as RegisterDto.username — re-validated here since it's
  // re-enterable any time, unlike registration where it's set once.
  @IsOptional()
  @Transform(lowercaseTrim)
  @Matches(/^[a-z0-9_]{3,20}$/, {
    message:
      'username must be 3-20 characters and contain only lowercase letters, numbers, or underscores',
  })
  username?: string;
}
