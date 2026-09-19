import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, Matches, MaxLength } from 'class-validator';

export class RecordChargebackDto {
  @MaxLength(100)
  @ApiProperty({
    description:
      "The original funding transaction's own reference, as recorded by Cliqpay",
  })
  originalTransactionReference: string;

  @IsInt()
  @IsPositive()
  @ApiProperty({
    example: 500000,
    description: 'Amount clawed back by the bank, in minor units (kobo)',
  })
  amount: number;

  // The dedupe key (§5, ADR-0016) — a repeat submission with the same value
  // is rejected, not re-posted. Also becomes the chargeback transaction's
  // own `reference` (LedgerService.postChargeback).
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'disputeReference must contain only letters, numbers, - or _',
  })
  @ApiProperty({
    example: 'kora-chargeback-8f3e2a1c',
    description:
      "The chargeback notice's own reference — Kora's own dispute/chargeback identifier, or another stable value ops can trace back to it.",
  })
  disputeReference: string;
}
