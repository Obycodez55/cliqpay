import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DeviceAttestationDto } from './device-attestation.dto';

export class VerifyMfaChallengeDto {
  @IsUUID()
  challengeId: string;

  @IsString()
  @Length(6, 6)
  code: string;

  @ApiPropertyOptional({
    description:
      'Base64 ECDSA P-256 public key of the device, registered when this device becomes trusted: ' +
      'either the raw 65-byte uncompressed point (0x04 ‖ X ‖ Y, iOS) or X.509 SubjectPublicKeyInfo DER (Android). ' +
      'Stored as SPKI. Required while DEVICE_KEY_REQUIRED is on.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  devicePublicKey?: string;

  @ApiPropertyOptional({ type: DeviceAttestationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceAttestationDto)
  attestation?: DeviceAttestationDto;
}
