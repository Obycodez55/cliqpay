import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../config';
import { runInTransaction } from '../../database/transaction.util';
import { AuditService } from '../../shared/audit/audit.service';
import {
  DeviceRegisteredEventPayload,
  RISK_REVIEW_OVERDUE_EVENT,
  RiskReviewOverdueEventPayload,
  TransferSentEventPayload,
} from '../../shared/events/domain-events';
import { EventBusService } from '../../shared/events/event-bus.service';
import { Money } from '../../shared/primitives/money';
import { AuthService } from '../auth/auth.service';
import { LedgerService } from '../ledger/ledger.service';
import { RestrictionReason, UsersService } from '../users/users.service';
import { LiftRestrictionDto } from './dto/lift-restriction.dto';
import { ListFlagsQueryDto } from './dto/list-flags-query.dto';
import { ReviewFlagDto } from './dto/review-flag.dto';
import {
  FraudFlag,
  FraudFlagStatus,
  OPEN_FLAG_STATUSES,
} from './entities/fraud-flag.entity';
import { FraudRule, FraudRuleCode } from './entities/fraud-rule.entity';
import { ScamCase } from './entities/scam-case.entity';
import {
  FraudFlagAlreadyResolvedException,
  FraudFlagHasOpenScamCasesException,
  FraudFlagNotFoundException,
  RestrictionNotFoundException,
  RestrictionNotLiftableException,
} from './internal/errors';
import {
  MuleFanInParams,
  NewAccountLargeWithdrawalParams,
  RuleHit,
  SendBurstParams,
  SharedDeviceParams,
  TaintedInflowParams,
  deviceIntegrity,
  muleFanIn,
  newAccountLargeWithdrawal,
  sendBurst,
  sharedDevice,
  taintedInflow,
} from './internal/rules';

export const REVIEW_TARGET_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOT_LIFTABLE: readonly RestrictionReason[] = [
  'dispute',
  'sanctions',
  'self_lock',
];
const OVERDUE_LIST_LIMIT = 20;
const MAX_FLAG_EVIDENCE = 50;

export interface WithdrawalEvaluation {
  held: boolean;
  flagIds: string[];
}

export interface Hit {
  ruleCode: FraudRuleCode;
  enforced: boolean;
  evidence: Record<string, unknown>;
}

/**
 * The one exported surface of the risk module (ADR-0032). Rules that guard
 * a withdrawal run inside its transaction under the user lock; the rest run
 * after commit from domain events. Detection never blocks anything except
 * a withdrawal.
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly ledgerService: LedgerService,
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly eventBus: EventBusService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // Caller must hold the user's advisory lock. Writes any flags in the
  // caller's transaction, so they commit or roll back with the withdrawal.
  async evaluateWithdrawal(
    manager: EntityManager,
    params: { userId: string; amount: Money },
  ): Promise<WithdrawalEvaluation> {
    const rules = await this.loadRules(manager);
    const now = Date.now();
    const hits: Hit[] = [];

    const collect = (code: FraudRuleCode, hit: RuleHit | null): void => {
      if (hit) {
        hits.push({
          ruleCode: code,
          enforced: rules.get(code)!.mode === 'enforce',
          evidence: { ...hit.evidence, at: new Date(now).toISOString() },
        });
      }
    };
    const active = (code: FraudRuleCode): FraudRule | null => {
      const rule = rules.get(code);
      return rule && rule.mode !== 'off' ? rule : null;
    };

    const muleRule = active('mule_fan_in');
    if (muleRule) {
      const p = muleRule.params as unknown as MuleFanInParams;
      const inflows = await this.ledgerService.getP2pInflowBySender(
        manager,
        params.userId,
        new Date(now - p.windowHours * HOUR_MS),
      );
      collect('mule_fan_in', muleFanIn(p, params.amount.amount, inflows));
    }

    const newAccountRule = active('new_account_large_withdrawal');
    if (newAccountRule) {
      const user = await this.usersService.findById(params.userId);
      collect(
        'new_account_large_withdrawal',
        newAccountLargeWithdrawal(
          newAccountRule.params as unknown as NewAccountLargeWithdrawalParams,
          params.amount.amount,
          now - user.createdAt.getTime(),
        ),
      );
    }

    const taintedRule = active('tainted_inflow');
    if (taintedRule) {
      const p = taintedRule.params as unknown as TaintedInflowParams;
      const inflows = await this.ledgerService.getP2pInflowBySender(
        manager,
        params.userId,
        new Date(now - p.windowHours * HOUR_MS),
      );
      const tainted = await this.findTaintedUsers(
        manager,
        inflows.map((i) => i.senderUserId),
      );
      collect('tainted_inflow', taintedInflow(p, inflows, tainted));
    }

    const flagIds: string[] = [];
    for (const hit of hits) {
      flagIds.push(await this.recordHit(manager, params.userId, hit));
    }
    const held =
      hits.some((hit) => hit.enforced) ||
      (await manager.getRepository(FraudFlag).existsBy({
        userId: params.userId,
        enforced: true,
        status: In([...OPEN_FLAG_STATUSES]),
      }));
    return { held, flagIds };
  }

  async hasEnforcedOpenFlag(userId: string): Promise<boolean> {
    return this.dataSource.getRepository(FraudFlag).existsBy({
      userId,
      enforced: true,
      status: In([...OPEN_FLAG_STATUSES]),
    });
  }

  async linkWithdrawal(
    manager: EntityManager,
    flagIds: string[],
    transactionId: string,
  ): Promise<void> {
    if (flagIds.length === 0) {
      return;
    }
    await manager.query(
      `UPDATE fraud_flags SET transaction_id = $1 WHERE id = ANY($2::uuid[]) AND transaction_id IS NULL`,
      [transactionId, flagIds],
    );
  }

  async handleTransferSent(payload: TransferSentEventPayload): Promise<void> {
    const rule = await this.loadActiveRule('send_burst');
    if (!rule) {
      return;
    }
    const p = rule.params as unknown as SendBurstParams;
    const now = Date.now();
    const velocity = await this.ledgerService.getP2pSendVelocity(
      payload.userId,
      {
        burstSince: new Date(now - p.burstWindowMinutes * MINUTE_MS),
        newRecipientsSince: new Date(
          now - p.newRecipientWindowMinutes * MINUTE_MS,
        ),
      },
    );
    await this.recordEventHit(payload.userId, rule, sendBurst(p, velocity), {
      reference: payload.reference,
    });
  }

  async handleDeviceRegistered(
    payload: DeviceRegisteredEventPayload,
  ): Promise<void> {
    const integrity = await this.loadActiveRule('device_integrity');
    if (integrity) {
      await this.recordEventHit(
        payload.userId,
        integrity,
        deviceIntegrity(payload.deviceId, payload.attestationResult),
      );
    }
    const shared = await this.loadActiveRule('shared_device');
    if (shared) {
      const p = shared.params as unknown as SharedDeviceParams;
      const users = await this.authService.countUsersBoundToDevice(
        payload.deviceId,
        new Date(Date.now() - p.windowDays * DAY_MS),
      );
      await this.recordEventHit(
        payload.userId,
        shared,
        sharedDevice(p, payload.deviceId, users),
      );
    }
  }

  async listFlags(
    query: ListFlagsQueryDto,
    enforced: boolean,
  ): Promise<FraudFlag[]> {
    return this.dataSource.getRepository(FraudFlag).find({
      where: {
        enforced,
        ...(query.status && { status: query.status }),
        ...(query.userId && { userId: query.userId }),
      },
      order: { createdAt: 'DESC' },
      take: query.limit ?? 50,
    });
  }

  async getFlag(id: string): Promise<FraudFlag> {
    const flag = await this.dataSource
      .getRepository(FraudFlag)
      .findOneBy({ id });
    if (!flag) {
      throw new FraudFlagNotFoundException();
    }
    return flag;
  }

  // The user lock goes first, matching a withdrawal's order, so a review and
  // a withdrawal evaluation for one user cannot deadlock on the flag row.
  async reviewFlag(
    id: string,
    dto: ReviewFlagDto,
    reviewerId: string,
  ): Promise<FraudFlag> {
    const current = await this.getFlag(id);
    return runInTransaction(this.dataSource, async (manager) => {
      await this.usersService.lockUser(manager, current.userId);
      const repo = manager.getRepository(FraudFlag);
      const flag = await repo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!flag) {
        throw new FraudFlagNotFoundException();
      }
      if (!canMove(flag.status, dto.status)) {
        throw new FraudFlagAlreadyResolvedException();
      }
      if (
        dto.status === 'cleared' &&
        flag.ruleCode === 'scam_report' &&
        (await manager.getRepository(ScamCase).existsBy({
          recipientUserId: flag.userId,
          status: 'open',
        }))
      ) {
        throw new FraudFlagHasOpenScamCasesException();
      }
      const from = flag.status;
      flag.status = dto.status;
      flag.reviewedBy = reviewerId;
      flag.reviewedAt = new Date();
      flag.reviewNote = dto.note ?? null;
      await repo.save(flag);

      if (dto.status === 'confirmed') {
        await this.usersService.addRestriction(manager, {
          userId: flag.userId,
          reason: 'fraud',
          scope: 'outbound',
          sourceId: flag.id,
          note: dto.note,
          actor: { type: 'reviewer', id: reviewerId },
        });
      }
      await this.auditService.record(manager, {
        actor: { type: 'reviewer', id: reviewerId },
        action: 'fraud_flag_reviewed',
        subject: { type: 'fraud_flag', id: flag.id },
        metadata: {
          userId: flag.userId,
          ruleCode: flag.ruleCode,
          from,
          to: dto.status,
          note: dto.note ?? null,
        },
      });
      return flag;
    });
  }

  async liftRestriction(
    dto: LiftRestrictionDto,
    reviewerId: string,
  ): Promise<void> {
    if (NOT_LIFTABLE.includes(dto.reason)) {
      throw new RestrictionNotLiftableException(dto.reason);
    }
    const lifted = await runInTransaction(this.dataSource, (manager) =>
      this.usersService.liftRestriction(manager, {
        userId: dto.userId,
        reason: dto.reason,
        sourceId: dto.sourceId,
        actor: { type: 'reviewer', id: reviewerId },
      }),
    );
    if (!lifted) {
      throw new RestrictionNotFoundException();
    }
  }

  // Nothing is resolved here: an overdue review only alerts ops.
  async alertOverdueReviews(): Promise<void> {
    const cutoff = new Date(Date.now() - REVIEW_TARGET_MS);
    const flags = await this.dataSource
      .getRepository(FraudFlag)
      .createQueryBuilder('flag')
      .where('flag.enforced = true')
      .andWhere('flag.status IN (:...open)', { open: [...OPEN_FLAG_STATUSES] })
      .andWhere('flag.createdAt < :cutoff', { cutoff })
      .orderBy('flag.createdAt', 'ASC')
      .getMany();
    const withdrawals = await this.ledgerService.findHeldWithdrawals({
      olderThan: cutoff,
    });
    if (flags.length === 0 && withdrawals.length === 0) {
      return;
    }
    const oldest = Math.min(
      ...flags.map((f) => f.createdAt.getTime()),
      ...withdrawals.map((w) => w.createdAt.getTime()),
    );
    const occurredAt = new Date();
    this.logger.error(
      `risk reviews overdue: ${flags.length} flag(s), ${withdrawals.length} held withdrawal(s)`,
    );
    await this.eventBus.publish<string, RiskReviewOverdueEventPayload>({
      name: RISK_REVIEW_OVERDUE_EVENT,
      payload: {
        email: this.config.payments.reconciliation.alertEmail,
        overdueFlags: flags.length,
        overdueWithdrawals: withdrawals.length,
        oldestHours: Math.floor((occurredAt.getTime() - oldest) / HOUR_MS),
        flagIds: flags.slice(0, OVERDUE_LIST_LIMIT).map((f) => f.id),
        withdrawalReferences: withdrawals
          .slice(0, OVERDUE_LIST_LIMIT)
          .map((w) => w.reference),
        occurredAt: occurredAt.toISOString(),
      },
      occurredAt,
    });
  }

  private async loadRules(
    manager: EntityManager,
  ): Promise<Map<FraudRuleCode, FraudRule>> {
    const rules = await manager.getRepository(FraudRule).find();
    return new Map(rules.map((rule) => [rule.code, rule]));
  }

  private async loadActiveRule(code: FraudRuleCode): Promise<FraudRule | null> {
    const rule = await this.dataSource
      .getRepository(FraudRule)
      .findOneBy({ code });
    return rule && rule.mode !== 'off' ? rule : null;
  }

  private async findTaintedUsers(
    manager: EntityManager,
    userIds: string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) {
      return new Set();
    }
    const flagged = await manager.getRepository(FraudFlag).find({
      where: {
        userId: In(userIds),
        enforced: true,
        status: In([...OPEN_FLAG_STATUSES]),
      },
      select: { userId: true },
    });
    const restricted = await this.usersService.getOpenRestrictionUserIds(
      userIds,
      'fraud',
    );
    return new Set([...flagged.map((f) => f.userId), ...restricted]);
  }

  private async recordEventHit(
    userId: string,
    rule: FraudRule,
    hit: RuleHit | null,
    extraEvidence: Record<string, unknown> = {},
  ): Promise<void> {
    if (!hit) {
      return;
    }
    await runInTransaction(this.dataSource, (manager) =>
      this.recordHit(manager, userId, {
        ruleCode: rule.code,
        enforced: rule.mode === 'enforce',
        evidence: {
          ...hit.evidence,
          ...extraEvidence,
          at: new Date().toISOString(),
        },
      }),
    );
  }

  // A repeat hit on an open flag appends evidence and counts, and upgrades
  // `enforced` if the rule has moved from shadow to enforce since the flag was
  // raised; it never downgrades. Evidence keeps the latest hits only:
  // `send_burst` can hit on every send.
  async recordHit(
    manager: EntityManager,
    userId: string,
    hit: Hit,
  ): Promise<string> {
    const [row] = await manager.query<{ id: string }[]>(
      `INSERT INTO fraud_flags (user_id, kind, rule_code, evidence, enforced)
       VALUES ($1, 'fraud', $2, jsonb_build_array($3::jsonb), $4)
       ON CONFLICT (user_id, rule_code) WHERE status IN ('open', 'reviewing')
       DO UPDATE SET hit_count = fraud_flags.hit_count + 1,
                     evidence = (
                       SELECT jsonb_agg(e ORDER BY ord)
                         FROM (
                           SELECT e, ord
                             FROM jsonb_array_elements(fraud_flags.evidence || EXCLUDED.evidence)
                                  WITH ORDINALITY AS x(e, ord)
                            ORDER BY ord DESC
                            LIMIT ${MAX_FLAG_EVIDENCE}
                         ) latest
                     ),
                     enforced = fraud_flags.enforced OR EXCLUDED.enforced,
                     updated_at = now()
       RETURNING id`,
      [userId, hit.ruleCode, JSON.stringify(hit.evidence), hit.enforced],
    );
    return row.id;
  }
}

function canMove(from: FraudFlagStatus, to: FraudFlagStatus): boolean {
  if (to === 'reviewing') {
    return from === 'open';
  }
  return from === 'open' || from === 'reviewing';
}
