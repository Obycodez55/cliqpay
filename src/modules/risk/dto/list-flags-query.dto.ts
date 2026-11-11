import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { FRAUD_FLAG_STATUSES } from '../entities/fraud-flag.entity';

export class ListFlagsQueryDto {
  @IsOptional()
  @IsIn(FRAUD_FLAG_STATUSES)
  @ApiProperty({ required: false, enum: FRAUD_FLAG_STATUSES })
  status?: (typeof FRAUD_FLAG_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  @ApiProperty({ required: false })
  userId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiProperty({ required: false, default: 50 })
  limit?: number;
}
