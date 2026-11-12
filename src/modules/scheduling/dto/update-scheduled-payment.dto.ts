import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  HasCodePointLength,
  normalizeText,
} from '../../../common/validation/text';
import {
  SCHEDULE_VISIBILITIES,
  ScheduleVisibility,
} from '../entities/scheduled-payment.entity';
import { ScheduleIntervalDto } from './create-scheduled-payment.dto';

const defined = (_: unknown, value: unknown) => value !== undefined;

export class UpdateScheduledPaymentDto {
  @ValidateIf(defined)
  @IsInt()
  @IsPositive()
  @ApiProperty({
    required: false,
    example: 500000,
    description:
      'New amount in minor units (kobo), from the next run on. Needs pin.',
  })
  amount?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScheduleIntervalDto)
  @ApiProperty({
    required: false,
    nullable: true,
    type: ScheduleIntervalDto,
    description:
      'Adds or changes the interval; null makes it a one-time payment. Re-anchors at the next run date. Needs pin.',
  })
  interval?: ScheduleIntervalDto | null;

  @ValidateIf(defined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'nextRunDate must be a YYYY-MM-DD date',
  })
  @ApiProperty({
    required: false,
    example: '2026-12-15',
    description:
      'Moves the next run to this Lagos date (tomorrow to one year ahead) and re-anchors the rhythm there. Needs pin.',
  })
  nextRunDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'endDate must be a YYYY-MM-DD date',
  })
  @ApiProperty({
    required: false,
    nullable: true,
    example: '2027-12-01',
    description:
      'Last Lagos date a run may fall on; null clears it. On or after the next run date. Needs pin.',
  })
  endDate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(366)
  @ApiProperty({
    required: false,
    nullable: true,
    example: 12,
    description:
      'Total runs, at least the number already created; null clears it. Needs pin.',
  })
  maxRuns?: number | null;

  @Transform(({ value }: { value: unknown }) => {
    if (value === null) {
      return null;
    }
    const note = normalizeText(value);
    return note === '' ? null : note;
  })
  @IsOptional()
  @IsString()
  @HasCodePointLength(1, 500)
  @ApiProperty({
    required: false,
    nullable: true,
    example: 'Rent',
    description: 'Null or empty clears the note. Needs no pin.',
  })
  note?: string | null;

  @ValidateIf(defined)
  @IsIn(SCHEDULE_VISIBILITIES)
  @ApiProperty({
    required: false,
    enum: SCHEDULE_VISIBILITIES,
    description: 'Needs no pin.',
  })
  visibility?: ScheduleVisibility;

  @IsOptional()
  @IsBoolean()
  @ApiProperty({
    required: false,
    description:
      'Send true to proceed after a 422 RISK_ACKNOWLEDGEMENT_REQUIRED response, which a higher amount on a payment to another user can return.',
  })
  riskAcknowledged?: boolean;

  @ValidateIf(defined)
  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({
    required: false,
    description:
      '4-digit transaction PIN. Required when amount, interval, nextRunDate, endDate or maxRuns is sent.',
  })
  pin?: string;
}
