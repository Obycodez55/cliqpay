import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const SCHEDULE_LIST_FILTERS = ['active', 'paused', 'ended'] as const;
export type ScheduleListFilter = (typeof SCHEDULE_LIST_FILTERS)[number];

export class ListScheduledPaymentsQueryDto {
  @IsOptional()
  @IsIn(SCHEDULE_LIST_FILTERS)
  @ApiPropertyOptional({
    enum: SCHEDULE_LIST_FILTERS,
    description:
      '`ended` is cancelled or completed. Omit for every schedule you own.',
  })
  status?: ScheduleListFilter;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  @ApiPropertyOptional({ default: 20, maximum: 50 })
  limit: number = 20;
}
