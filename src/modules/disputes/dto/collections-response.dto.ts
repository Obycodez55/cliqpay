import { ApiProperty } from '@nestjs/swagger';
import {
  ChargebackTransactionForWallet,
  NegativeBalanceWallet,
} from '../../ledger/ledger.service';
import { Dispute, DisputeStatus } from '../entities/dispute.entity';

class MoneyDto {
  @ApiProperty()
  amount: string;

  @ApiProperty()
  currency: string;
}

class CollectionsChargebackDto {
  @ApiProperty()
  chargebackTransactionId: string;

  @ApiProperty({ type: MoneyDto })
  amount: { amount: string; currency: string };

  @ApiProperty()
  disputeReference: string;

  @ApiProperty({ enum: ['open', 'resolved', 'upheld'] })
  disputeStatus: DisputeStatus;
}

// One entry per wallet currently in negative balance (issue #37). A wallet
// can have been partially charged back more than once (§4.2 allows a
// further partial chargeback against an already-`disputed` original), so
// `chargebacks` is a list rather than a single originating transaction —
// ops needs to see every contributing chargeback to act on the full debt,
// not just the most recent one.
export class CollectionsEntryDto {
  @ApiProperty()
  userId: string;

  @ApiProperty({
    type: MoneyDto,
    description: 'Current wallet balance — negative by construction here',
  })
  balance: { amount: string; currency: string };

  @ApiProperty({
    description: 'Whether the account is currently frozen from a chargeback',
  })
  isFrozen: boolean;

  @ApiProperty({ type: [CollectionsChargebackDto] })
  chargebacks: CollectionsChargebackDto[];
}

export function toCollectionsEntry(
  wallet: NegativeBalanceWallet,
  chargebacks: ChargebackTransactionForWallet[],
  disputesByChargebackId: Map<string, Dispute>,
  isFrozen: boolean,
): CollectionsEntryDto {
  return {
    userId: wallet.userId,
    balance: {
      amount: wallet.balance.amount.toString(),
      currency: wallet.balance.currency,
    },
    isFrozen,
    chargebacks: chargebacks.map((chargeback) => {
      const dispute = disputesByChargebackId.get(chargeback.transactionId);
      if (!dispute) {
        // Every chargeback transaction is created together with its
        // `disputes` row in one DB transaction (DisputesService.
        // postChargebackAtomically) — a chargeback with no matching
        // dispute row is a data-integrity invariant violation, not a
        // reachable "no dispute yet" state to handle gracefully.
        throw new Error(
          `toCollectionsEntry: no dispute row found for chargeback transaction "${chargeback.transactionId}"`,
        );
      }
      return {
        chargebackTransactionId: chargeback.transactionId,
        amount: {
          amount: chargeback.amount.amount.toString(),
          currency: chargeback.amount.currency,
        },
        disputeReference: dispute.disputeReference,
        disputeStatus: dispute.status,
      };
    }),
  };
}
