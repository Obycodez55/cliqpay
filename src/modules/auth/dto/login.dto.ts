import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';
import { DEVICE_SIGNATURE_DESCRIPTION } from './device-signature.docs';

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class LoginDto {
  @Transform(lowercaseTrim)
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  @ApiPropertyOptional({
    description:
      'Nonce from `POST /auth/device-challenge` with purpose `login`. Required on a trusted device while DEVICE_KEY_REQUIRED is on.',
  })
  @IsOptional()
  @IsString()
  nonce?: string;

  @ApiPropertyOptional({
    description: DEVICE_SIGNATURE_DESCRIPTION('login'),
  })
  @IsOptional()
  @IsString()
  signature?: string;
}
