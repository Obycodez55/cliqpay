import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString } from 'class-validator';
import { COMMENT_MAX_LENGTH } from '../entities/post-comment.entity';
import {
  HasCodePointLength,
  normalizeText,
} from '../../../common/validation/text';

export class AddCommentDto {
  @Transform(({ value }: { value: unknown }) => normalizeText(value))
  @IsString()
  @HasCodePointLength(1, COMMENT_MAX_LENGTH)
  @ApiProperty({ minLength: 1, maxLength: COMMENT_MAX_LENGTH })
  body: string;
}
