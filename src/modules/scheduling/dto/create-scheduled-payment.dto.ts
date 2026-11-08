import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  ValidationArguments,
  registerDecorator,
} from 'class-validator';
import {
  HasCodePointLength,
  normalizeText,
} from '../../../common/validation/text';
import { IsNotReservedReference } from '../../../common/validation/reference';
import { INTERVAL_UNITS, IntervalUnit } from '../internal/run-time';
import {
  SCHEDULE_VISIBILITIES,
  ScheduleVisibility,
} from '../entities/scheduled-payment.entity';

export const MAX_INTERVAL_COUNT: Record<IntervalUnit, number> = {
  day: 365,
  week: 52,
  month: 12,
};

function IsWithinUnitLimit() {
  return (target: object, propertyName: string) =>
    registerDecorator({
      target: target.constructor,
      propertyName,
      validator: {
        validate: (value: unknown, args: ValidationArguments) => {
          const unit = (args.object as ScheduleIntervalDto).unit;
          return (
            typeof value === 'number' &&
            value <= (MAX_INTERVAL_COUNT[unit] ?? Infinity)
          );
        },
        defaultMessage: (args: ValidationArguments) =>
          `count must be at most ${MAX_INTERVAL_COUNT[(args.object as ScheduleIntervalDto).unit]} for a ${(args.object as ScheduleIntervalDto).unit} interval`,
      },
    });
}

export class ScheduleIntervalDto {
  @IsIn(INTERVAL_UNITS)
  @ApiProperty({ enum: INTERVAL_UNITS })
  unit: IntervalUnit;

  @IsInt()
  @Min(1)
  @IsWithinUnitLimit()
  @ApiProperty({
    example: 1,
    description: 'Every how many units: 1–365 days, 1–52 weeks or 1–12 months',
  })
  count: number;
}

export class ScheduleTargetDto {
  @Equals('user')
  @ApiProperty({ enum: ['user'] })
  type: 'user';

  @IsUUID()
  @ApiProperty({ description: "The recipient's user id" })
  userId: string;
}

export class CreateScheduledPaymentDto {
  @IsNotReservedReference()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'reference must contain only letters, numbers, - or _',
  })
  @ApiProperty({
    example: 'cliqpay-sched-8f3e2a1c',
    description:
      'Client-supplied idempotency key, unique per user. Replaying it with the same contents returns the original schedule; with different contents it is a 409.',
  })
  reference: string;

  @ValidateNested()
  @Type(() => ScheduleTargetDto)
  @ApiProperty({ type: ScheduleTargetDto })
  target: ScheduleTargetDto;

  @IsInt()
  @IsPositive()
  @ApiProperty({ example: 500000, description: 'Amount in minor units (kobo)' })
  amount: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'startDate must be a YYYY-MM-DD date',
  })
  @ApiProperty({
    example: '2026-12-01',
    description:
      'Lagos calendar date of the payment: tomorrow at the earliest, one year ahead at the latest. The payment runs on the morning of that date.',
  })
  startDate: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScheduleIntervalDto)
  @ApiProperty({
    required: false,
    type: ScheduleIntervalDto,
    description:
      'Makes the schedule recurring. Omit for a one-time payment. Every run is counted from startDate, so a month interval starting on the 31st pays on the last day of shorter months.',
  })
  interval?: ScheduleIntervalDto;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'endDate must be a YYYY-MM-DD date',
  })
  @ApiProperty({
    required: false,
    example: '2027-12-01',
    description:
      'Last Lagos date a run may fall on, inclusive. On or after startDate. Needs interval; not with maxRuns.',
  })
  endDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(366)
  @ApiProperty({
    required: false,
    example: 12,
    description:
      'Stop after this many runs, counting every run whatever its outcome. Needs interval; not with endDate.',
  })
  maxRuns?: number;

  @Transform(({ value }: { value: unknown }) => {
    const note = normalizeText(value);
    return note === '' ? undefined : note;
  })
  @IsOptional()
  @IsString()
  @HasCodePointLength(1, 500)
  @ApiProperty({ required: false, example: 'Rent' })
  note?: string;

  @IsIn(SCHEDULE_VISIBILITIES)
  @ApiProperty({
    enum: SCHEDULE_VISIBILITIES,
    description:
      'Whether the transfer made on the run date may appear in the activity feed. Required; there is no default.',
  })
  visibility: ScheduleVisibility;

  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({
    description:
      '4-digit transaction PIN, which authorises every run of this schedule',
  })
  pin: string;
}
