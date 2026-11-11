import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const REVIEW_TARGET_STATUSES = [
  'reviewing',
  'cleared',
  'confirmed',
] as const;
export type ReviewTargetStatus = (typeof REVIEW_TARGET_STATUSES)[number];

export class ReviewFlagDto {
  @IsIn(REVIEW_TARGET_STATUSES)
  @ApiProperty({
    enum: REVIEW_TARGET_STATUSES,
    description:
      "'confirmed' adds a fraud restriction on outbound money. Clearing a flag does not release its held withdrawals.",
  })
  status: ReviewTargetStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiProperty({ required: false })
  note?: string;
}
