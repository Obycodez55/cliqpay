import { ApiProperty } from '@nestjs/swagger';

// The four safe fields for showing another user's identity — no email,
// phone, verification status, or account age (see issue #21). Shared by
// recipient lookup and transaction-history counterparty display so both
// stay in lockstep on what's safe to expose.
export class IdentitySummaryDto {
  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  userId: string;

  @ApiProperty({ example: 'jane_doe' })
  username: string;

  @ApiProperty({ example: 'Jane' })
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  lastName: string;
}

export function toIdentitySummary(user: {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}): IdentitySummaryDto {
  return {
    userId: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}
