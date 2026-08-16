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
  // request with the same value and the same amount returns the original
  // result rather than initiating a second charge. Must be globally unique;
  // a UUID is recommended (ADR-0010) — a reference reused across users
  // returns 409, and reused with a different amount returns 422.
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'reference must contain only letters, numbers, - or _',
  })
  @ApiProperty({
    example: 'cliqpay-fund-8f3e2a1c',
    description:
      'Client-supplied idempotency key. Must be globally unique — a UUID is recommended.',
  })
  reference: string;
}
