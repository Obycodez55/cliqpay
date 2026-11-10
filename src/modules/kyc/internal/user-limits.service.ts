import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { runInTransaction } from '../../../database/transaction.util';
import { Money } from '../../../shared/primitives/money';
import { AuditService } from '../../../shared/audit/audit.service';
import { UsersService } from '../../users/users.service';
import { TierLimit } from '../entities/tier-limit.entity';
import { UserLimit } from '../entities/user-limit.entity';
import {
  LimitAboveTierException,
  LimitNotHigherException,
  LimitNotLowerException,
  NoPendingLimitIncreaseException,
  TierLimitNotConfiguredException,
} from './errors';
import { LIMIT_INCREASE_DELAY_MS, resolveUserLimit } from './user-limit';

const CURRENCY = 'NGN';

export interface UserLimitView {
  dailyOutflowLimit: Money | null;
  pendingIncrease: { amount: Money; effectiveAt: Date } | null;
}

@Injectable()
export class UserLimitsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
  ) {}

  async lower(userId: string, amount: number): Promise<UserLimitView> {
    return runInTransaction(this.dataSource, async (manager) => {
      await this.usersService.lockUser(manager, userId);
      const { tierLimit, current } = await this.load(manager, userId);
      const effective = this.effective(tierLimit, current);
      const target = BigInt(amount);
      if (target >= effective) {
        throw new LimitNotLowerException();
      }
      const saved = await this.save(manager, userId, current, {
        dailyOutflowLimitMinor: target,
        pendingDailyOutflowLimitMinor: null,
        pendingEffectiveAt: null,
      });
      await this.auditService.record(manager, {
        actor: { type: 'user', id: userId },
        action: 'daily_limit_lowered',
        subject: { type: 'user', id: userId },
        metadata: { from: effective.toString(), to: target.toString() },
      });
      return this.toView(saved);
    });
  }

  async raise(userId: string, amount: number): Promise<UserLimitView> {
    const effectiveAt = new Date(Date.now() + LIMIT_INCREASE_DELAY_MS);
    const target = BigInt(amount);
    return runInTransaction(this.dataSource, async (manager) => {
      await this.usersService.lockUser(manager, userId);
      const { tierLimit, current } = await this.load(manager, userId);
      if (target > tierLimit.dailyDebitLimitMinor) {
        throw new LimitAboveTierException(
          Money.of(tierLimit.dailyDebitLimitMinor, CURRENCY),
        );
      }
      const effective = this.effective(tierLimit, current);
      if (target <= effective) {
        throw new LimitNotHigherException();
      }
      const saved = await this.save(manager, userId, current, {
        pendingDailyOutflowLimitMinor: target,
        pendingEffectiveAt: effectiveAt,
      });
      await this.auditService.record(manager, {
        actor: { type: 'user', id: userId },
        action: 'daily_limit_raise_requested',
        subject: { type: 'user', id: userId },
        metadata: {
          from: effective.toString(),
          to: target.toString(),
          effectiveAt: effectiveAt.toISOString(),
        },
      });
      return this.toView(saved);
    });
  }

  async cancelPending(userId: string): Promise<UserLimitView> {
    return runInTransaction(this.dataSource, async (manager) => {
      await this.usersService.lockUser(manager, userId);
      const { current } = await this.load(manager, userId);
      const resolved = resolveUserLimit(current, new Date());
      if (!current || !resolved.pending) {
        throw new NoPendingLimitIncreaseException();
      }
      const saved = await this.save(manager, userId, current, {
        pendingDailyOutflowLimitMinor: null,
        pendingEffectiveAt: null,
      });
      await this.auditService.record(manager, {
        actor: { type: 'user', id: userId },
        action: 'daily_limit_raise_cancelled',
        subject: { type: 'user', id: userId },
        metadata: { cancelled: resolved.pending.amount.toString() },
      });
      return this.toView(saved);
    });
  }

  private async load(
    manager: EntityManager,
    userId: string,
  ): Promise<{ tierLimit: TierLimit; current: UserLimit | null }> {
    const tier = await this.usersService.getKycTier(manager, userId);
    const tierLimit = await manager
      .getRepository(TierLimit)
      .findOneBy({ tier, currency: CURRENCY });
    if (!tierLimit) {
      throw new TierLimitNotConfiguredException();
    }
    const current = await manager
      .getRepository(UserLimit)
      .findOneBy({ userId });
    return { tierLimit, current };
  }

  private effective(tierLimit: TierLimit, current: UserLimit | null): bigint {
    const { limit } = resolveUserLimit(current, new Date());
    return limit !== null && limit < tierLimit.dailyDebitLimitMinor
      ? limit
      : tierLimit.dailyDebitLimitMinor;
  }

  // A pending raise that has come due is folded in first, so a later change
  // never discards an increase the user has already been granted.
  private async save(
    manager: EntityManager,
    userId: string,
    current: UserLimit | null,
    changes: Partial<
      Pick<
        UserLimit,
        | 'dailyOutflowLimitMinor'
        | 'pendingDailyOutflowLimitMinor'
        | 'pendingEffectiveAt'
      >
    >,
  ): Promise<UserLimit> {
    const repo = manager.getRepository(UserLimit);
    const resolved = resolveUserLimit(current, new Date());
    const row =
      current ??
      repo.create({
        userId,
        dailyOutflowLimitMinor: null,
        pendingDailyOutflowLimitMinor: null,
        pendingEffectiveAt: null,
      });
    row.dailyOutflowLimitMinor = resolved.limit;
    row.pendingDailyOutflowLimitMinor = resolved.pending?.amount ?? null;
    row.pendingEffectiveAt = resolved.pending?.effectiveAt ?? null;
    Object.assign(row, changes);
    return repo.save(row);
  }

  private toView(row: UserLimit | null): UserLimitView {
    const resolved = resolveUserLimit(row, new Date());
    return {
      dailyOutflowLimit:
        resolved.limit === null ? null : Money.of(resolved.limit, CURRENCY),
      pendingIncrease: resolved.pending && {
        amount: Money.of(resolved.pending.amount, CURRENCY),
        effectiveAt: resolved.pending.effectiveAt,
      },
    };
  }
}
