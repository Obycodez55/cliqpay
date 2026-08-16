import { ApiProperty } from '@nestjs/swagger';
import { User } from '../entities/user.entity';

// Enough to confirm identity before sending money — no email, phone,
// verification status, or account age (see issue #21).
export class RecipientLookupResponseDto {
  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  userId: string;

  @ApiProperty({ example: 'jane_doe' })
  username: string;

  @ApiProperty({ example: 'Jane' })
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  lastName: string;
}

export function toRecipientLookupResponse(
  user: User,
): RecipientLookupResponseDto {
  return {
    userId: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}
