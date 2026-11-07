import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CursorPaginationQueryDto } from '../../../common/dto/cursor-pagination-query.dto';
import {
  BILL_SPLIT_API_STATUSES,
  BillSplitApiStatus,
} from './bill-split-response.dto';

export const BILL_SPLIT_LIST_ROLES = ['initiator', 'participant'] as const;
export type BillSplitListRole = (typeof BILL_SPLIT_LIST_ROLES)[number];

export class ListBillSplitsQueryDto extends CursorPaginationQueryDto {
  @IsIn(BILL_SPLIT_LIST_ROLES)
  @ApiProperty({
    enum: BILL_SPLIT_LIST_ROLES,
    description:
      'initiator: splits you created. participant: splits you were asked to pay into.',
  })
  role: BillSplitListRole;

  @IsOptional()
  @IsIn(BILL_SPLIT_API_STATUSES)
  @ApiPropertyOptional({
    enum: [...BILL_SPLIT_API_STATUSES],
    description:
      "Filters on the split's own stored state. A split whose last payment or decline was recorded late may be filed under its previous status until the next read of it repairs it; each item's `status` is always live.",
  })
  status?: BillSplitApiStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}
