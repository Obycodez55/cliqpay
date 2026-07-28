import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../../common/dto/money-response.dto';
import { Money } from '../../../shared/primitives/money';

// Structural, not `Account`/`User` — auth's DTO layer has no business
// importing ledger's or users' entity (docs/architecture.md §10: only a
// module's exported service is importable from outside it). Only the
// fields this response actually needs.
export interface WalletSummary {
  id: string;
  currency: string;
  balance: bigint;
}

export interface UserSummary {
  id: string;
  email: string;
  username: string;
  phone: string;
  firstName: string;
  lastName: string;
  createdAt: Date;
}

class RegisteredUserDto {
  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  id: string;

  @ApiProperty({ example: 'jane@example.com' })
  email: string;

  @ApiProperty({ example: 'jane_doe' })
  username: string;

  @ApiProperty({ example: '+2348012345678' })
  phone: string;

  @ApiProperty({ example: 'Jane' })
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  lastName: string;

  @ApiProperty({ example: '2026-07-28T19:15:00.000Z' })
  createdAt: Date;
}

class RegisteredWalletDto {
  @ApiProperty({ example: '9f8b6e2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3' })
  id: string;

  @ApiProperty({ example: 'NGN' })
  currency: string;

  @ApiProperty({ type: MoneyDto })
  balance: MoneyDto;
}

export class RegisterResponseDto {
  @ApiProperty({ type: RegisteredUserDto })
  user: RegisteredUserDto;

  @ApiProperty({ type: RegisteredWalletDto })
  wallet: RegisteredWalletDto;
}

// Explicit shape, never the raw entity — passwordHash/transactionPinHash
// must never reach a response.
export function toRegisterResponse(
  user: UserSummary,
  wallet: WalletSummary,
): RegisterResponseDto {
  return {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      createdAt: user.createdAt,
    },
    wallet: {
      id: wallet.id,
      currency: wallet.currency,
      balance: Money.of(wallet.balance, wallet.currency).toJSON(),
    },
  };
}
