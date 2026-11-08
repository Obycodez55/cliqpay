import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListScheduledPaymentRunsQueryDto {
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
