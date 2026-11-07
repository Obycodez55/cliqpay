import { EntityManager, WhereExpressionBuilder } from 'typeorm';
import { MoneyRequest } from '../entities/money-request.entity';

// Applied to every query that treats a request as still actionable — a
// `pending` row whose `expiresAt` has passed presents as expired but is
// never rewritten, so `status = 'pending'` alone is wrong
// everywhere: the pair cap, cancel, and decline all go through this one
// helper instead of separately-reasoned-about WHERE clauses that could
// drift.
export function applyEffectivelyPending<T extends WhereExpressionBuilder>(
  qb: T,
  alias: string,
  now: Date,
): T {
  return qb
    .andWhere(`${alias}.status = :pendingStatus`, { pendingStatus: 'pending' })
    .andWhere(`${alias}.expiresAt > :now`, { now });
}

// Same predicate as applyEffectivelyPending, evaluated against an
// already-fetched row — callers lock the row first and then decide.
export function isEffectivelyPending(
  moneyRequest: MoneyRequest,
  now: Date,
): boolean {
  return moneyRequest.status === 'pending' && moneyRequest.expiresAt > now;
}

export async function countEffectivelyPending(
  manager: EntityManager,
  requesterId: string,
  payerId: string,
  now: Date,
): Promise<number> {
  return applyEffectivelyPending(
    manager
      .getRepository(MoneyRequest)
      .createQueryBuilder('moneyRequest')
      .where('moneyRequest.requesterUserId = :requesterId', { requesterId })
      .andWhere('moneyRequest.payerUserId = :payerId', { payerId }),
    'moneyRequest',
    now,
  ).getCount();
}
