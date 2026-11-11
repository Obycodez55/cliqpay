import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { SCAM_CASE_STATUSES } from '../entities/scam-case.entity';

export class ListScamCasesQueryDto {
  @IsOptional()
  @IsIn(SCAM_CASE_STATUSES)
  @ApiProperty({ required: false, enum: SCAM_CASE_STATUSES })
  status?: (typeof SCAM_CASE_STATUSES)[number];

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @ApiProperty({
    required: false,
    description: 'Only open cases past their due date.',
  })
  overdue?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiProperty({ required: false, default: 50 })
  limit?: number;
}
