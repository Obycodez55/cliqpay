import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class VerifyBvnDto {
  @Matches(/^\d{11}$/, { message: 'bvn must be exactly 11 digits' })
  @ApiProperty({
    example: '12345678901',
    description: "The user's 11-digit BVN",
  })
  bvn: string;
}
