import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../../config';
import { runInTransaction } from '../../../database/transaction.util';
import { AuditActor, AuditService } from '../../../shared/audit/audit.service';
import {
  SCAM_CASES_DUE_EVENT,
  SCAM_CASE_RESOLVED_EVENT,
  SCAM_FUNDS_HELD_EVENT,
  ScamCaseResolvedEventPayload,
  ScamCasesDueEventPayload,
  ScamFundsHeldEventPayload,
} from '../../../shared/events/domain-events';
import { EventBusService } from '../../../shared/events/event-bus.service';
import { Money } from '../../../shared/primitives/money';
import { LedgerService } from '../../ledger/ledger.service';
import { UsersService } from '../../users/users.service';
import { CreateScamReportDto } from '../dto/create-scam-report.dto';
import { ListScamCasesQueryDto } from '../dto/list-scam-cases-query.dto';
import { ResolveScamCaseDto } from '../dto/resolve-scam-case.dto';
import { FraudRule } from '../entities/fraud-rule.entity';
import { ScamCase, ScamCaseStatus } from '../entities/scam-case.entity';
import { RiskService } from '../risk.service';
import {
  ScamCaseAlreadyDecidedException,
  ScamCaseNotFoundException,
  ScamReportAlreadyFiledException,
  ScamReportNotReportableException,
  ScamReportTransferNotFoundException,
  ScamReportWindowExpiredException,
} from './errors';
import { addWeekdays } from './working-days';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SCAM_REPORT_WINDOW_MS = 30 * DAY_MS;
const SCAM_LATE_AFTER_MS = 72 * HOUR_MS;
const SCAM_INVESTIGATION_WEEKDAYS = 14;
const SCAM_DUE_ALERT_WEEKDAYS = 2;
const SYSTEM: AuditActor = { type: 'system', id: null };
const DEFAULT_MIN_DISTINCT_REPORTERS = 2;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LIST_LIMIT = 50;
const DUE_LIST_LIMIT = 20;

type Decision = Exclude<ScamCaseStatus, 'open'>;

interface Decider {
  actor: AuditActor;
  reason: string | null;
}

/**
 * Internal to `risk`: the scam case lifecycle. The hold and its
 * release or recovery are postings `ledger` decides; this decides when they
 * happen and what the case does to the recipient's flag and restrictions.
 */
@Injectable()
export class ScamCasesService {
  private readonly logger = new Logger(ScamCasesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly ledgerService: LedgerService,
    private readonly riskService: RiskService,
    private readonly auditService: AuditService,
    private readonly eventBus: EventBusService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async report(
    reporterUserId: string,
    dto: CreateScamReportDto,
  ): Promise<ScamCase> {
    const transfer = await this.ledgerService.getP2pTransfer(
      this.dataSource.manager,
      dto.transactionId,
    );
    if (!transfer || transfer.senderUserId !== reporterUserId) {
      throw new ScamReportTransferNotFoundException();
    }
    if (transfer.status !== 'completed') {
      throw new ScamReportNotReportableException();
    }
    const now = new Date();
    const age = now.getTime() - transfer.createdAt.getTime();
    if (age > SCAM_REPORT_WINDOW_MS) {
      throw new ScamReportWindowExpiredException();
    }

    const { scamCase, held } = await runInTransaction(
      this.dataSource,
      async (manager) => {
        await this.usersService.lockUser(manager, transfer.recipientUserId);
        const repo = manager.getRepository(ScamCase);
        if (await repo.existsBy({ transactionId: transfer.transactionId })) {
          throw new ScamReportAlreadyFiledException();
        }
        const reference = await this.nextReference(manager);
        const movement =
          await this.ledgerService.postFraudHoldWithinTransaction(manager, {
            caseReference: reference,
            recipientUserId: transfer.recipientUserId,
            amount: transfer.amount,
          });
        const heldAmount = movement?.amount.amount ?? 0n;

        const scamCase = await repo.save(
          repo.create({
            reference,
            transactionId: transfer.transactionId,
            reporterUserId,
            recipientUserId: transfer.recipientUserId,
            currency: transfer.amount.currency,
            reportedAmount: transfer.amount.amount,
            heldAmount,
            recoveredAmount: 0n,
            reimbursedAmount: null,
            category: dto.category,
            description: dto.description,
            contactChannel: dto.contactChannel ?? null,
            status: 'open',
            late: age > SCAM_LATE_AFTER_MS,
            dueAt: addWeekdays(now, SCAM_INVESTIGATION_WEEKDAYS),
          }),
        );

        const rule = await this.loadRule(manager);
        let flagged = false;
        if (rule && rule.mode !== 'off') {
          await this.riskService.recordHit(manager, transfer.recipientUserId, {
            ruleCode: 'scam_report',
            enforced: rule.mode === 'enforce',
            evidence: {
              caseReference: reference,
              reporterUserId,
              reported: transfer.amount.amount.toString(),
              held: heldAmount.toString(),
              at: now.toISOString(),
            },
          });
          flagged = true;
        }
        if (rule?.mode === 'enforce') {
          const reporters = await this.countOpenReporters(
            manager,
            transfer.recipientUserId,
            rule,
          );
          if (reporters >= minDistinctReporters(rule)) {
            scamCase.restrictionAdded = await this.usersService.addRestriction(
              manager,
              {
                userId: transfer.recipientUserId,
                reason: 'fraud',
                scope: 'outbound',
                sourceId: scamCase.id,
                note: `Scam reports from ${reporters} users, pending review of ${reference}`,
                actor: SYSTEM,
              },
            );
            await repo.update(
              { id: scamCase.id },
              { restrictionAdded: scamCase.restrictionAdded },
            );
          }
        }

        await this.auditService.record(manager, {
          actor: { type: 'user', id: reporterUserId },
          action: 'scam_report_filed',
          subject: { type: 'scam_case', id: scamCase.id },
          metadata: {
            reference,
            transactionId: transfer.transactionId,
            reported: transfer.amount.amount.toString(),
            held: heldAmount.toString(),
            shortfall: (transfer.amount.amount - heldAmount).toString(),
            late: scamCase.late,
            flagged,
            restrictionAdded: scamCase.restrictionAdded,
            holdTransactionId: movement?.transactionId ?? null,
          },
        });
        return { scamCase, held: heldAmount };
      },
    );

    await this.publishFundsHeld(scamCase, held);
    return scamCase;
  }

  async listForReporter(reporterUserId: string): Promise<ScamCase[]> {
    return this.dataSource.getRepository(ScamCase).find({
      where: { reporterUserId },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
  }

  async submitResponse(
    recipientUserId: string,
    reference: string,
    response: string,
  ): Promise<void> {
    await runInTransaction(this.dataSource, async (manager) => {
      await this.usersService.lockUser(manager, recipientUserId);
      const repo = manager.getRepository(ScamCase);
      const scamCase = await repo.findOne({
        where: { reference, recipientUserId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!scamCase) {
        throw new ScamCaseNotFoundException();
      }
      if (scamCase.status !== 'open') {
        throw new ScamCaseAlreadyDecidedException();
      }
      await repo.update(
        { id: scamCase.id },
        { recipientResponse: response, recipientRespondedAt: new Date() },
      );
      await this.auditService.record(manager, {
        actor: { type: 'user', id: recipientUserId },
        action: 'scam_report_responded',
        subject: { type: 'scam_case', id: scamCase.id },
        metadata: { reference },
      });
    });
  }

  async withdraw(reporterUserId: string, reference: string): Promise<ScamCase> {
    const current = await this.dataSource
      .getRepository(ScamCase)
      .findOneBy({ reference, reporterUserId });
    if (!current) {
      throw new ScamCaseNotFoundException();
    }
    return this.decide(current, 'withdrawn', {
      actor: { type: 'user', id: reporterUserId },
      reason: null,
    });
  }

  async resolve(
    reference: string,
    dto: ResolveScamCaseDto,
    reviewerId: string,
  ): Promise<ScamCase> {
    const current = await this.getCase(reference);
    return this.decide(current, dto.outcome, {
      actor: { type: 'reviewer', id: reviewerId },
      reason: dto.reason,
    });
  }

  async getCase(reference: string): Promise<ScamCase> {
    const scamCase = await this.dataSource
      .getRepository(ScamCase)
      .findOneBy({ reference });
    if (!scamCase) {
      throw new ScamCaseNotFoundException();
    }
    return scamCase;
  }

  async listCases(query: ListScamCasesQueryDto): Promise<ScamCase[]> {
    const builder = this.dataSource
      .getRepository(ScamCase)
      .createQueryBuilder('c');
    if (query.status) {
      builder.andWhere('c.status = :status', { status: query.status });
    }
    if (query.overdue) {
      builder
        .andWhere(`c.status = 'open'`)
        .andWhere('c.dueAt < :now', { now: new Date() })
        .orderBy('c.dueAt', 'ASC');
    } else {
      builder.orderBy('c.createdAt', 'DESC');
    }
    return builder.take(query.limit ?? DEFAULT_LIST_LIMIT).getMany();
  }

  // Alerts every run until the backlog is cleared and keeps no alert state,
  // like the review digest. Nothing is decided here.
  async alertCasesDue(): Promise<void> {
    const now = new Date();
    const cases = await this.dataSource
      .getRepository(ScamCase)
      .createQueryBuilder('c')
      .where(`c.status = 'open'`)
      .andWhere('c.dueAt <= :threshold', {
        threshold: addWeekdays(now, SCAM_DUE_ALERT_WEEKDAYS),
      })
      .orderBy('c.dueAt', 'ASC')
      .getMany();
    if (cases.length === 0) {
      return;
    }
    const overdue = cases.filter((c) => c.dueAt < now).length;
    this.logger.error(
      `scam cases near or past due: ${cases.length - overdue} due soon, ${overdue} overdue`,
    );
    await this.eventBus.publish<string, ScamCasesDueEventPayload>({
      name: SCAM_CASES_DUE_EVENT,
      payload: {
        email: this.config.payments.reconciliation.alertEmail,
        dueSoon: cases.length - overdue,
        overdue,
        caseReferences: cases.slice(0, DUE_LIST_LIMIT).map((c) => c.reference),
        occurredAt: now.toISOString(),
      },
      occurredAt: now,
    });
  }

  private async decide(
    current: ScamCase,
    outcome: Decision,
    decider: Decider,
  ): Promise<ScamCase> {
    const scamCase = await runInTransaction(
      this.dataSource,
      async (manager) => {
        await this.usersService.lockUser(manager, current.recipientUserId);
        const repo = manager.getRepository(ScamCase);
        const locked = await repo.findOne({
          where: { id: current.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) {
          throw new ScamCaseNotFoundException();
        }
        if (locked.status !== 'open') {
          throw new ScamCaseAlreadyDecidedException();
        }

        const now = new Date();
        const upheld = outcome === 'upheld';
        const held = Money.of(locked.heldAmount, locked.currency);
        const movement = upheld
          ? await this.ledgerService.postScamRecoveryWithinTransaction(
              manager,
              {
                caseReference: locked.reference,
                reporterUserId: locked.reporterUserId,
                amount: held,
              },
            )
          : await this.ledgerService.postFraudHoldReleaseWithinTransaction(
              manager,
              {
                caseReference: locked.reference,
                recipientUserId: locked.recipientUserId,
                amount: held,
              },
            );

        locked.status = outcome;
        locked.recoveredAmount = upheld ? locked.heldAmount : 0n;
        locked.decisionReason = decider.reason;
        locked.decidedBy = decider.actor.id;
        locked.decidedAt = now;
        await repo.save(locked);

        const rule = await this.loadRule(manager);
        const flagId = upheld
          ? await this.settleFlag(manager, locked, 'confirmed', decider)
          : await this.clearFlagIfLastOpenCase(manager, locked, decider);
        if (upheld) {
          const added = await this.usersService.addRestriction(manager, {
            userId: locked.recipientUserId,
            reason: 'fraud',
            scope: 'outbound',
            sourceId: locked.id,
            note: `Scam case ${locked.reference} upheld`,
            actor: decider.actor,
          });
          if (added && !locked.restrictionAdded) {
            locked.restrictionAdded = true;
            await repo.update({ id: locked.id }, { restrictionAdded: true });
          }
        } else if (rule) {
          await this.liftPendingRestrictions(manager, locked, rule, decider);
        }

        await this.auditService.record(manager, {
          actor: decider.actor,
          action:
            outcome === 'withdrawn'
              ? 'scam_report_withdrawn'
              : 'scam_case_resolved',
          subject: { type: 'scam_case', id: locked.id },
          metadata: {
            reference: locked.reference,
            outcome,
            reason: decider.reason,
            held: locked.heldAmount.toString(),
            recovered: locked.recoveredAmount.toString(),
            flagId,
            transactionId: movement?.transactionId ?? null,
          },
        });
        return locked;
      },
    );

    await this.publishResolved(scamCase, outcome);
    return scamCase;
  }

  private async settleFlag(
    manager: EntityManager,
    scamCase: ScamCase,
    status: 'cleared' | 'confirmed',
    decider: Decider,
  ): Promise<string | null> {
    const [row] = await manager.query<{ id: string }[]>(
      `UPDATE fraud_flags
          SET status = $1, reviewed_by = $2, reviewed_at = now(),
              review_note = $3, updated_at = now()
        WHERE user_id = $4 AND rule_code = 'scam_report'
          AND status IN ('open', 'reviewing')
        RETURNING id`,
      [
        status,
        decider.actor.id ?? decider.actor.type,
        `Scam case ${scamCase.reference} ${scamCase.status}`,
        scamCase.recipientUserId,
      ],
    );
    return row?.id ?? null;
  }

  // One flag stands for every open case against the recipient, so it stays
  // open, and their withdrawals stay held, while any other case is open.
  private async clearFlagIfLastOpenCase(
    manager: EntityManager,
    scamCase: ScamCase,
    decider: Decider,
  ): Promise<string | null> {
    const others = await manager.getRepository(ScamCase).count({
      where: { recipientUserId: scamCase.recipientUserId, status: 'open' },
    });
    return others === 0
      ? this.settleFlag(manager, scamCase, 'cleared', decider)
      : null;
  }

  // An upheld case keeps its own restriction; only pending ones are lifted.
  private async liftPendingRestrictions(
    manager: EntityManager,
    scamCase: ScamCase,
    rule: FraudRule,
    decider: Decider,
  ): Promise<void> {
    const reporters = await this.countOpenReporters(
      manager,
      scamCase.recipientUserId,
      rule,
    );
    if (reporters >= minDistinctReporters(rule)) {
      return;
    }
    const pending = await manager.getRepository(ScamCase).find({
      where: {
        recipientUserId: scamCase.recipientUserId,
        restrictionAdded: true,
        status: In(['open', 'rejected', 'withdrawn']),
      },
    });
    for (const candidate of pending) {
      await this.usersService.liftRestriction(manager, {
        userId: candidate.recipientUserId,
        reason: 'fraud',
        sourceId: candidate.id,
        actor: decider.actor,
      });
    }
  }

  private async countOpenReporters(
    manager: EntityManager,
    recipientUserId: string,
    rule: FraudRule,
  ): Promise<number> {
    const windowDays = rule.params.windowDays ?? DEFAULT_WINDOW_DAYS;
    const row = await manager
      .getRepository(ScamCase)
      .createQueryBuilder('c')
      .select('COUNT(DISTINCT c.reporterUserId)', 'reporters')
      .where('c.recipientUserId = :recipientUserId', { recipientUserId })
      .andWhere(`c.status = 'open'`)
      .andWhere('c.createdAt >= :since', {
        since: new Date(Date.now() - windowDays * DAY_MS),
      })
      .getRawOne<{ reporters: string }>();
    return Number(row?.reporters ?? 0);
  }

  private loadRule(manager: EntityManager): Promise<FraudRule | null> {
    return manager.getRepository(FraudRule).findOneBy({ code: 'scam_report' });
  }

  private async nextReference(manager: EntityManager): Promise<string> {
    const [row] = await manager.query<{ n: string }[]>(
      `SELECT nextval('scam_case_reference_seq') AS n`,
    );
    return `SCM-${row.n.padStart(6, '0')}`;
  }

  private async publishFundsHeld(
    scamCase: ScamCase,
    held: bigint,
  ): Promise<void> {
    try {
      const recipient = await this.usersService.findById(
        scamCase.recipientUserId,
      );
      await this.eventBus.publish<string, ScamFundsHeldEventPayload>({
        name: SCAM_FUNDS_HELD_EVENT,
        payload: {
          userId: recipient.id,
          email: recipient.email,
          amount: Money.of(held, scamCase.currency).toDecimalString(),
          currency: scamCase.currency,
          held: held > 0n,
          caseReference: scamCase.reference,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `Scam case ${scamCase.reference} filed, but notifying the recipient failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }

  private async publishResolved(
    scamCase: ScamCase,
    outcome: Decision,
  ): Promise<void> {
    try {
      const users = await this.usersService.findByIds([
        scamCase.reporterUserId,
        scamCase.recipientUserId,
      ]);
      const byId = new Map(users.map((user) => [user.id, user]));
      const moved = Money.of(scamCase.heldAmount, scamCase.currency);
      const parties = [
        {
          party: 'reporter' as const,
          user: byId.get(scamCase.reporterUserId),
          amount: outcome === 'upheld' ? moved : Money.zero(scamCase.currency),
        },
        {
          party: 'recipient' as const,
          user: byId.get(scamCase.recipientUserId),
          amount: outcome === 'upheld' ? Money.zero(scamCase.currency) : moved,
        },
      ];
      for (const { party, user, amount } of parties) {
        if (!user) {
          continue;
        }
        await this.eventBus.publish<string, ScamCaseResolvedEventPayload>({
          name: SCAM_CASE_RESOLVED_EVENT,
          payload: {
            userId: user.id,
            email: user.email,
            caseReference: scamCase.reference,
            party,
            outcome,
            amount: amount.toDecimalString(),
            currency: scamCase.currency,
            reason:
              party === 'reporter' && outcome === 'rejected'
                ? scamCase.decisionReason
                : null,
          },
          occurredAt: new Date(),
        });
      }
    } catch (error) {
      this.logger.error(
        `Scam case ${scamCase.reference} decided, but notifying the parties failed (${(error as Error).message}) — this will not be retried`,
      );
    }
  }
}

function minDistinctReporters(rule: FraudRule): number {
  return rule.params.minDistinctReporters ?? DEFAULT_MIN_DISTINCT_REPORTERS;
}
