import { ApiProperty } from '@nestjs/swagger';

// Docs-only mirror of Money.toJSON()'s return shape — money is a bigint
// internally, but JSON has no bigint type, so it's serialized as a decimal
// string of minor units. See docs/architecture.md's money rules.
export class MoneyDto {
  @ApiProperty({ example: '150000', description: 'Minor units, as a string' })
  amount: string;

  @ApiProperty({ example: 'NGN' })
  currency: string;
}
