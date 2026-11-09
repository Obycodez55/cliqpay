import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  ATTESTATION_PLATFORMS,
  AttestationPlatform,
} from '../attestation/device-attestation-verifier';

export class DeviceAttestationDto {
  @ApiProperty({ enum: ATTESTATION_PLATFORMS })
  @IsIn(ATTESTATION_PLATFORMS)
  platform: AttestationPlatform;

  @ApiProperty({
    description:
      'The nonce from `POST /auth/device-challenge` with purpose `register`.',
  })
  @IsString()
  nonce: string;

  @ApiPropertyOptional({
    description: 'iOS only: the App Attest key id, base64.',
  })
  @IsOptional()
  @IsString()
  keyId?: string;

  @ApiProperty({
    description:
      'iOS: the base64 App Attest attestation object. Android: the Play Integrity token. ' +
      'The attested client data is the UTF-8 string `attest`, `nonce`, `X-Device-Id` and the base64 of the ' +
      '65-byte uncompressed P-256 point of `devicePublicKey`, joined by LF (0x0A). iOS passes its SHA-256 as ' +
      'App Attest clientDataHash; Android passes base64url(SHA-256) as the Play Integrity nonce.',
  })
  @IsString()
  @MaxLength(20_000)
  token: string;
}
