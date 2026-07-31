import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, Matches, MaxLength } from 'class-validator';

export class FundWalletDto {
  @IsInt()
  @IsPositive()
  @ApiProperty({
    example: 500000,
    description: 'Amount in minor units (kobo)',
  })
  amount: number;

  // Client-supplied idempotency key (docs/architecture.md §3.4) — a repeat
  // request with the same value returns the original result rather than
  // initiating a second charge.
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'reference must contain only letters, numbers, - or _',
  })
  @ApiProperty({ example: 'cliqpay-fund-8f3e2a1c' })
  reference: string;
}
