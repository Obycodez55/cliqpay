import { Money } from '../../../shared/primitives/money';
import { BillSplitMode } from '../entities/bill-split.entity';
import {
  BillSplitParticipantsInvalidException,
  BillSplitSharesInvalidException,
  BillSplitShareTooSmallException,
} from './errors';

export interface ShareInput {
  userId: string;
  amount?: number;
}

export interface ComputedShares {
  initiatorShare: Money;
  shares: { userId: string; amount: Money }[];
}

export function computeShares(
  mode: BillSplitMode,
  total: Money,
  participants: ShareInput[],
  minShare: Money,
): ComputedShares {
  let result: ComputedShares;
  if (mode === 'equal') {
    if (participants.some((p) => p.amount !== undefined)) {
      throw new BillSplitParticipantsInvalidException(
        'Participant amounts are only allowed in custom mode',
      );
    }
    const [initiatorShare, ...rest] = total.allocate(participants.length + 1);
    result = {
      initiatorShare,
      shares: participants.map((p, i) => ({
        userId: p.userId,
        amount: rest[i],
      })),
    };
  } else {
    if (participants.some((p) => p.amount === undefined)) {
      throw new BillSplitParticipantsInvalidException(
        'Every participant needs an amount in custom mode',
      );
    }
    const shares = participants.map((p) => ({
      userId: p.userId,
      amount: Money.of(p.amount!, total.currency),
    }));
    const requested = shares.reduce(
      (sum, share) => sum.add(share.amount),
      Money.zero(total.currency),
    );
    if (requested.greaterThan(total)) {
      throw new BillSplitSharesInvalidException(
        'The amounts for the participants add up to more than the total',
      );
    }
    result = { initiatorShare: total.subtract(requested), shares };
  }

  if (result.shares.some((share) => share.amount.lessThan(minShare))) {
    throw new BillSplitShareTooSmallException(minShare.toDecimalString());
  }
  return result;
}
