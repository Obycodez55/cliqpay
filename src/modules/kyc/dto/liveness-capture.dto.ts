import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBase64,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export const MAX_LIVENESS_IMAGE_BASE64_LENGTH = 1_000_000;
export const MIN_LIVENESS_IMAGES = 6;
export const MAX_LIVENESS_IMAGES = 8;

// "/9j/" is the base64 of a JPEG's FF D8 FF header.
const JPEG_BASE64_PREFIX = /^\/9j\//;
const IMAGE_ERROR =
  'must be a base64-encoded JPEG of at most 1,000,000 characters';

export class LivenessCaptureDto {
  @IsString()
  @MaxLength(MAX_LIVENESS_IMAGE_BASE64_LENGTH, {
    message: `selfieImage ${IMAGE_ERROR}`,
  })
  @IsBase64({}, { message: `selfieImage ${IMAGE_ERROR}` })
  @Matches(JPEG_BASE64_PREFIX, { message: `selfieImage ${IMAGE_ERROR}` })
  @ApiProperty({
    description: `Base64-encoded JPEG selfie, at most ${MAX_LIVENESS_IMAGE_BASE64_LENGTH} characters. Used for the liveness check and never stored.`,
  })
  selfieImage: string;

  @IsArray()
  @ArrayMinSize(MIN_LIVENESS_IMAGES)
  @ArrayMaxSize(MAX_LIVENESS_IMAGES)
  @IsString({ each: true })
  @MaxLength(MAX_LIVENESS_IMAGE_BASE64_LENGTH, {
    each: true,
    message: `each livenessImages entry ${IMAGE_ERROR}`,
  })
  @IsBase64(
    {},
    { each: true, message: `each livenessImages entry ${IMAGE_ERROR}` },
  )
  @Matches(JPEG_BASE64_PREFIX, {
    each: true,
    message: `each livenessImages entry ${IMAGE_ERROR}`,
  })
  @ApiProperty({
    type: [String],
    description: `${MIN_LIVENESS_IMAGES} to ${MAX_LIVENESS_IMAGES} base64-encoded JPEG frames from the liveness capture, each at most ${MAX_LIVENESS_IMAGE_BASE64_LENGTH} characters. Never stored.`,
  })
  livenessImages: string[];

  @Equals(true, { message: 'consentGranted must be true' })
  @ApiProperty({
    description:
      'The user consented to biometric processing. Must be true; the grant time is recorded server-side.',
  })
  consentGranted: boolean;
}
