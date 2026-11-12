import { EntityManager } from 'typeorm';
import { Money } from '../../../shared/primitives/money';
import { Account } from '../entities/account.entity';
import { LedgerEntry } from '../entities/ledger-entry.entity';
import {
  ScamCaseTransactionMetadata,
  Transaction,
} from '../entities/transaction.entity';
import { InsufficientFundsException } from './errors';

export type FraudHoldMovementType =
  | 'fraud_hold'
  | 'fraud_hold_release'
  | 'scam_recovery';

export interface FraudHoldMovementParams {
  type: FraudHoldMovementType;
  caseReference: string;
  userId: string;
  amount: Money;
  clampToBalance?: boolean;
}

export interface FraudHoldMovement {
  transactionId: string;
  reference: string;
  amount: Money;
}

const REFERENCE_SUFFIX: Record<FraudHoldMovementType, string> = {
  fraud_hold: 'hold',
  fraud_hold_release: 'release',
  scam_recovery: 'recovery',
};

export function fraudHoldReference(
  caseReference: string,
  type: FraudHoldMovementType,
): string {
  return `${caseReference}-${REFERENCE_SUFFIX[type]}`;
}

export async function postFraudHoldMovement(
  manager: EntityManager,
  params: FraudHoldMovementParams,
): Promise<FraudHoldMovement | null> {
  const currency = params.amount.currency;
  const accounts = await manager
    .getRepository(Account)
    .createQueryBuilder('account')
    .where(
      `(account.role = 'user_wallet' AND account.userId = :userId AND account.currency = :currency)
       OR (account.role = 'fraud_hold' AND account.provider IS NULL AND account.userId IS NULL AND account.currency = :currency)`,
      { userId: params.userId, currency },
    )
    .orderBy('account.id', 'ASC')
    .setLock('pessimistic_write')
    .getMany();
  const wallet = accounts.find((a) => a.role === 'user_wallet');
  const hold = accounts.find((a) => a.role === 'fraud_hold');
  if (!wallet || !hold) {
    throw new Error(
      `${params.type}: missing wallet or fraud_hold account for case "${params.caseReference}"`,
    );
  }

  const toHold = params.type === 'fraud_hold';
  const source = toHold ? wallet : hold;
  const destination = toHold ? hold : wallet;
  const sourceBalance = Money.of(source.balance, currency);
  const amount =
    params.clampToBalance && sourceBalance.lessThan(params.amount)
      ? sourceBalance
      : params.amount;
  if (!amount.isPositive()) {
    return null;
  }
  if (sourceBalance.lessThan(amount)) {
    if (toHold) {
      throw new InsufficientFundsException();
    }
    throw new Error(
      `${params.type}: fraud_hold holds less than the ${amount.amount} to move for case "${params.caseReference}"`,
    );
  }

  const reference = fraudHoldReference(params.caseReference, params.type);
  const transactionRepo = manager.getRepository(Transaction);
  const holdTransaction = toHold
    ? null
    : await transactionRepo.findOneBy({
        reference: fraudHoldReference(params.caseReference, 'fraud_hold'),
      });
  const transaction = await transactionRepo.save(
    transactionRepo.create({
      reference,
      provider: null,
      providerReference: null,
      type: params.type,
      status: 'completed',
      reversesTransactionId: holdTransaction?.id ?? null,
      amount: amount.amount,
      currency,
      senderWalletId: toHold ? wallet.id : null,
      recipientWalletId: toHold ? null : wallet.id,
      metadata: {
        caseReference: params.caseReference,
      } satisfies ScamCaseTransactionMetadata,
    }),
  );

  const newSourceBalance = sourceBalance.subtract(amount);
  const newDestinationBalance = Money.of(destination.balance, currency).add(
    amount,
  );
  source.balance = newSourceBalance.amount;
  destination.balance = newDestinationBalance.amount;
  await manager.getRepository(Account).save([source, destination]);

  const entryRepo = manager.getRepository(LedgerEntry);
  await entryRepo.save([
    entryRepo.create({
      transactionId: transaction.id,
      accountId: source.id,
      direction: 'debit',
      amount: amount.amount,
      runningBalance: newSourceBalance.amount,
    }),
    entryRepo.create({
      transactionId: transaction.id,
      accountId: destination.id,
      direction: 'credit',
      amount: amount.amount,
      runningBalance: newDestinationBalance.amount,
    }),
  ]);

  return { transactionId: transaction.id, reference, amount };
}
