import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  Matches,
  MaxLength,
} from 'class-validator';
import { POST_VISIBILITIES, PostVisibility } from '../../social/social.service';
import { IsNotReservedReference } from '../../../common/validation/reference';

// No amount, no recipient — both come from the request row, never the
// client (ADR-0012: exact-amount-only). Same idempotency/PIN contract as
// SendTransferDto (ADR-0010, ADR-0009) — paying a request is still a
// distinct client-initiated money movement and needs its own reference.
export class PayMoneyRequestDto {
  @IsNotReservedReference()
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

  @IsOptional()
  @IsIn(POST_VISIBILITIES)
  @ApiProperty({
    enum: POST_VISIBILITIES,
    required: false,
    description:
      'Whether the resulting transfer may appear in the activity feed. Required, with no default, when paying a direct request; sending it for a group-share request (one share of a bill split) is a 400, because that payment records no post.',
  })
  visibility?: PostVisibility;

  @Matches(/^\d{4}$/, { message: 'pin must be exactly 4 digits' })
  @ApiProperty({ description: '4-digit transaction PIN' })
  pin: string;

  @IsOptional()
  @IsBoolean()
  @ApiProperty({
    required: false,
    description:
      'Send true to proceed after a 422 RISK_ACKNOWLEDGEMENT_REQUIRED response. The reference and signature stay the same.',
  })
  riskAcknowledged?: boolean;
}
