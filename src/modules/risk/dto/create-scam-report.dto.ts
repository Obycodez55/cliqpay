import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  HasCodePointLength,
  normalizeText,
} from '../../../common/validation/text';
import { SCAM_CATEGORIES } from '../entities/scam-case.entity';

export class CreateScamReportDto {
  @IsUUID()
  @ApiProperty({ description: 'The id of the P2P transfer you sent.' })
  transactionId: string;

  @IsIn(SCAM_CATEGORIES)
  @ApiProperty({ enum: SCAM_CATEGORIES })
  category: (typeof SCAM_CATEGORIES)[number];

  @Transform(({ value }) => normalizeText(value))
  @IsString()
  @HasCodePointLength(10, 1000)
  @ApiProperty({ description: 'What happened, in your own words.' })
  description: string;

  @IsOptional()
  @Transform(({ value }) => normalizeText(value))
  @IsString()
  @MaxLength(200)
  @ApiProperty({
    required: false,
    description: 'How the recipient contacted you, such as WhatsApp or a call.',
  })
  contactChannel?: string;
}
