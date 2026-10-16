import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class VerifyNinDto {
  @Matches(/^\d{11}$/, { message: 'nin must be exactly 11 digits' })
  @ApiProperty({
    example: '12345678901',
    description: "The user's 11-digit NIN",
  })
  nin: string;
}
