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

export interface RegisterResponseDto {
  user: {
    id: string;
    email: string;
    username: string;
    phone: string;
    firstName: string;
    lastName: string;
    createdAt: Date;
  };
  wallet: {
    id: string;
    currency: string;
    balance: { amount: string; currency: string };
  };
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
