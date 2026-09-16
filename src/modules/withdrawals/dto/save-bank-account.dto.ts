import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length, Matches } from 'class-validator';

export class SaveBankAccountDto {
  // Kora's own bank codes (CBN codes for NGN banks) — numeric, no fixed
  // length across every institution Kora lists.
  @Matches(/^\d{3,10}$/, { message: 'bankCode must be 3-10 digits' })
  @ApiProperty({ example: '033', description: "Provider's bank code" })
  bankCode: string;

  // NUBAN — every Nigerian bank account number is exactly 10 digits.
  @Matches(/^\d{10}$/, { message: 'accountNumber must be exactly 10 digits' })
  @ApiProperty({ example: '0000000000' })
  accountNumber: string;

  @IsUUID()
  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  challengeId: string;

  @IsString()
  @Length(6, 6)
  @ApiProperty({ example: '482913' })
  code: string;
}
