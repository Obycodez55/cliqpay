import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  DEVICE_CHALLENGE_PURPOSES,
  DeviceChallengePurpose,
} from '../entities/device-challenge.entity';

export class DeviceChallengeDto {
  @ApiProperty({
    enum: DEVICE_CHALLENGE_PURPOSES,
    description:
      '`login` and `refresh` challenge a signed request; `register` challenges a device attestation.',
  })
  @IsIn(DEVICE_CHALLENGE_PURPOSES)
  purpose: DeviceChallengePurpose;
}

export class DeviceChallengeResponseDto {
  @ApiProperty({
    description:
      'Single-use, 43 base64url characters. Signed exactly as received (its ASCII bytes), not decoded.',
    example: 'dGhpcyBpcyBhIDMyIGJ5dGUgcmFuZG9tIG5vbmNlISE',
  })
  nonce: string;

  @ApiProperty({
    description:
      'Expiry, 2 minutes after issue. Bound to the X-Device-Id it was requested with and to the purpose.',
  })
  expiresAt: Date;
}
