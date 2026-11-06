import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, ValidateBy } from 'class-validator';
import { COMMENT_MAX_LENGTH } from '../entities/post-comment.entity';

// Counted in code points, as Postgres counts varchar length, so an emoji
// can't pass validation and then overflow the column.
function hasCodePointLength(min: number, max: number) {
  return ValidateBy({
    name: 'hasCodePointLength',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string') {
          return false;
        }
        const length = [...value].length;
        return length >= min && length <= max;
      },
      defaultMessage: () => `body must be between ${min} and ${max} characters`,
    },
  });
}

export class AddCommentDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @hasCodePointLength(1, COMMENT_MAX_LENGTH)
  @ApiProperty({ minLength: 1, maxLength: COMMENT_MAX_LENGTH })
  body: string;
}
