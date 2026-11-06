import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CursorPaginationQueryDto } from '../../../common/dto/cursor-pagination-query.dto';

export const INCOMING_BUCKETS = ['following', 'others'] as const;
export type IncomingBucket = (typeof INCOMING_BUCKETS)[number];

export class ListIncomingMoneyRequestsQueryDto extends CursorPaginationQueryDto {
  @IsOptional()
  @IsIn(INCOMING_BUCKETS)
  @ApiPropertyOptional({
    enum: INCOMING_BUCKETS,
    description:
      'Requests from users you currently follow, or from everyone else. Omit for both.',
  })
  bucket?: IncomingBucket;
}
