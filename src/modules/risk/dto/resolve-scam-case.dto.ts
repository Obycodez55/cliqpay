import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString } from 'class-validator';
import {
  HasCodePointLength,
  normalizeText,
} from '../../../common/validation/text';

export const SCAM_RESOLUTIONS = ['upheld', 'rejected'] as const;
export type ScamResolution = (typeof SCAM_RESOLUTIONS)[number];

export class ResolveScamCaseDto {
  @IsIn(SCAM_RESOLUTIONS)
  @ApiProperty({
    enum: SCAM_RESOLUTIONS,
    description:
      "'upheld' returns the held amount to the reporter and restricts the recipient; 'rejected' returns it to the recipient.",
  })
  outcome: ScamResolution;

  @Transform(({ value }) => normalizeText(value))
  @IsString()
  @HasCodePointLength(1, 500)
  @ApiProperty({
    description: 'Shown to the reporter when a case is rejected.',
  })
  reason: string;
}
