import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString } from 'class-validator';
import {
  HasCodePointLength,
  normalizeText,
} from '../../../common/validation/text';

export class ScamResponseDto {
  @Transform(({ value }) => normalizeText(value))
  @IsString()
  @HasCodePointLength(1, 2000)
  @ApiProperty({ description: 'Your side of what happened.' })
  response: string;
}
