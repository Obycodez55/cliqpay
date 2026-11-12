import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, IsUUID, Length, Matches, Min } from 'class-validator';
import { MoneyDto } from '../../../common/dto/money-response.dto';

type MoneyResponse = { amount: string; currency: string };

export class LowerDailyLimitDto {
  @IsInt()
  @Min(0)
  @ApiProperty({ example: 5_000_000, description: 'New daily limit in kobo.' })
  amount: number;

  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({ example: '4821' })
  pin: string;
}

export class RaiseDailyLimitDto extends LowerDailyLimitDto {
  @IsUUID()
  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  challengeId: string;

  @IsString()
  @Length(6, 6)
  @ApiProperty({ example: '482913' })
  code: string;
}

export class CancelLimitIncreaseDto {
  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({ example: '4821' })
  pin: string;
}

export class UserLimitResponseDto {
  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: 'The limit that applies now; null when none is set.',
  })
  dailyOutflowLimit: MoneyResponse | null;

  @ApiProperty({
    nullable: true,
    description: 'A raise waiting out its 24-hour delay.',
    example: {
      amount: { amount: '10000000', currency: 'NGN' },
      effectiveAt: '2026-11-11T10:00:00.000Z',
    },
  })
  pendingIncrease: { amount: MoneyResponse; effectiveAt: string } | null;
}
