import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AuditActorType, AuditEvent } from './entities/audit-event.entity';

export type AuditAction =
  | 'restriction_added'
  | 'restriction_lifted'
  | 'device_trusted'
  | 'device_revoked'
  | 'security_cooldown_started'
  | 'bank_account_saved'
  | 'daily_limit_lowered'
  | 'daily_limit_raise_requested'
  | 'daily_limit_raise_cancelled'
  | 'account_self_locked'
  | 'email_recovered'
  | 'fraud_flag_reviewed'
  | 'withdrawal_released'
  | 'withdrawal_rejected';

export interface AuditActor {
  type: AuditActorType;
  id: string | null;
}

export interface AuditEventInput {
  actor: AuditActor;
  action: AuditAction;
  subject: { type: string; id: string };
  metadata?: Record<string, unknown>;
  requestId?: string;
}

@Injectable()
export class AuditService {
  async record(manager: EntityManager, event: AuditEventInput): Promise<void> {
    const repo = manager.getRepository(AuditEvent);
    await repo.save(
      repo.create({
        actorType: event.actor.type,
        actorId: event.actor.id,
        action: event.action,
        subjectType: event.subject.type,
        subjectId: event.subject.id,
        metadata: event.metadata ?? null,
        requestId: event.requestId ?? null,
      }),
    );
  }
}
