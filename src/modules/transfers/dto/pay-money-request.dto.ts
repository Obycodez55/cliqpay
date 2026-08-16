import { ApiProperty } from '@nestjs/swagger';
import { Matches, MaxLength } from 'class-validator';

// No amount, no recipient — both come from the request row, never the
// client (ADR-0012: exact-amount-only). Same idempotency/PIN contract as
// SendTransferDto (ADR-0010, ADR-0009) — paying a request is still a
// distinct client-initiated money movement and needs its own reference.
export class PayMoneyRequestDto {
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'reference must contain only letters, numbers, - or _',
  })
  @ApiProperty({
    example: 'cliqpay-payreq-8f3e2a1c',
    description:
      'Client-supplied idempotency key. Must be globally unique — a UUID is recommended.',
  })
  reference: string;

  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({ description: '4-digit transaction PIN' })
  pin: string;
}
