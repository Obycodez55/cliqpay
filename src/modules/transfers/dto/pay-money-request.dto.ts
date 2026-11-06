import { ApiProperty } from '@nestjs/swagger';
import { IsIn, Matches, MaxLength } from 'class-validator';
import { POST_VISIBILITIES, PostVisibility } from '../../social/social.service';

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

  @IsIn(POST_VISIBILITIES)
  @ApiProperty({
    enum: POST_VISIBILITIES,
    description:
      'Whether the resulting transfer may appear in the activity feed. Required; there is no default.',
  })
  visibility: PostVisibility;

  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({ description: '4-digit transaction PIN' })
  pin: string;
}
