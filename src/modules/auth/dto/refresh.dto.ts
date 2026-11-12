import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { DEVICE_SIGNATURE_DESCRIPTION } from './device-signature.docs';

export class RefreshDto {
  @IsString()
  refreshToken: string;

  @ApiPropertyOptional({
    description:
      'Nonce from `POST /auth/device-challenge` with purpose `refresh`. Required while DEVICE_KEY_REQUIRED is on.',
  })
  @IsOptional()
  @IsString()
  nonce?: string;

  @ApiPropertyOptional({
    description: DEVICE_SIGNATURE_DESCRIPTION('refresh'),
  })
  @IsOptional()
  @IsString()
  signature?: string;
}
