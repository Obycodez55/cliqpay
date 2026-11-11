import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityNotFoundError } from 'typeorm';
import { runInTransaction } from '../../../database/transaction.util';
import { APP_CONFIG, AppConfig } from '../../../config';
import { AuditActor, AuditService } from '../../../shared/audit/audit.service';
import { encryptionKeyFromHex } from '../../../shared/crypto/secrets.util';
import { verifySelfLockToken } from '../../../shared/crypto/self-lock-token.util';
import {
  ACCOUNT_SELF_LOCKED_EVENT,
  AccountSelfLockedEventPayload,
} from '../../../shared/events/domain-events';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { AuthService } from '../../auth/auth.service';
import { KycService } from '../../kyc/kyc.service';
import { UsersService } from '../../users/users.service';
import { SelfLockTokenInvalidException } from './errors';

export type SelfLockMethod = 'app' | 'link';

// Lives here, beside the limit endpoints, because the lock has to touch
// `auth` (sessions, devices) and `kyc` (a pending limit raise) in one
// transaction and `auth` may not import `kyc`.
@Injectable()
export class SelfLockService {
  private readonly logger = new Logger(SelfLockService.name);
  private readonly tokenKey: Buffer;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly usersService: UsersService,
    private readonly kycService: KycService,
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly eventBus: EventBusService,
  ) {
    this.tokenKey = encryptionKeyFromHex(config.selfLock.tokenKey);
  }

  async lockWithToken(token: string): Promise<void> {
    const verified = verifySelfLockToken(this.tokenKey, token);
    if (!verified) {
      throw new SelfLockTokenInvalidException();
    }
    try {
      await this.usersService.findById(verified.userId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new SelfLockTokenInvalidException();
      }
      throw error;
    }
    await this.lock(verified.userId, 'link');
  }

  // Everything runs under the user's advisory lock, taken before any wallet
  // row is touched, so a withdrawal already in flight either commits before
  // the lock does or is refused by the restriction check it makes under the
  // same lock. A repeat lock revokes again but sends no second confirmation.
  async lock(userId: string, method: SelfLockMethod): Promise<void> {
    const actor: AuditActor = { type: 'user', id: userId };
    const newlyLocked = await runInTransaction(
      this.dataSource,
      async (manager) => {
        await this.usersService.lockUser(manager, userId);
        const added = await this.usersService.addRestriction(manager, {
          userId,
          reason: 'self_lock',
          scope: 'outbound',
          sourceId: userId,
          note: method,
          actor,
        });
        const revoked = await this.authService.revokeAllAccess(manager, userId);
        const limitRaiseCancelled =
          await this.kycService.cancelPendingLimitRaiseIfAny(
            manager,
            userId,
            actor,
          );
        await this.usersService.clearPendingContactChanges(manager, userId);
        await this.auditService.record(manager, {
          actor,
          action: 'account_self_locked',
          subject: { type: 'user', id: userId },
          metadata: {
            method,
            alreadyLocked: !added,
            ...revoked,
            limitRaiseCancelled,
          },
        });
        return added;
      },
    );
    if (newlyLocked) {
      await this.publishLockConfirmation(userId);
    }
  }

  private async publishLockConfirmation(userId: string): Promise<void> {
    try {
      const user = await this.usersService.findById(userId);
      const occurredAt = new Date();
      await this.eventBus.publish<string, AccountSelfLockedEventPayload>({
        name: ACCOUNT_SELF_LOCKED_EVENT,
        payload: {
          userId,
          email: user.email,
          occurredAt: occurredAt.toISOString(),
        },
        occurredAt,
      });
    } catch (error) {
      this.logger.error(
        `Account ${userId} locked, but publishing the confirmation failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}
