import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, IsUUID, Matches, MaxLength } from 'class-validator';

export class InitiateWithdrawalDto {
  @IsUUID()
  @ApiProperty({ description: "One of the caller's own saved bank accounts" })
  bankAccountId: string;

  @IsInt()
  @IsPositive()
  @ApiProperty({
    example: 500000,
    description: 'Amount in minor units (kobo)',
  })
  amount: number;

  // Same idempotency contract as SendTransferDto (docs/architecture.md §3.4,
  // ADR-0010) — a repeat with the same value and parameters returns the
  // original result; reused across users returns 409; reused with different
  // parameters returns 422.
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'reference must contain only letters, numbers, - or _',
  })
  @ApiProperty({
    example: 'cliqpay-wd-8f3e2a1c',
    description:
      'Client-supplied idempotency key. Must be globally unique — a UUID is recommended.',
  })
  reference: string;

  // Required on every withdrawal (ADR-0009) — no amount threshold, no
  // unlock window, same as SendTransferDto.
  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({ description: '4-digit transaction PIN' })
  pin: string;
}
