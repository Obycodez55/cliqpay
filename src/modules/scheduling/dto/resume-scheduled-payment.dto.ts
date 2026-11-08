import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class ResumeScheduledPaymentDto {
  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({ description: '4-digit transaction PIN' })
  pin: string;
}
