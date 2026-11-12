import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const AUDIT_ACTOR_TYPES = ['user', 'reviewer', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

// Append-only, enforced by a trigger.
@Entity('audit_events')
@Check('CHK_audit_events_actor_type', inList('actor_type', AUDIT_ACTOR_TYPES))
@Index('IDX_audit_events_subject', ['subjectType', 'subjectId', 'occurredAt'])
export class AuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt: Date;

  @Column('varchar')
  actorType: AuditActorType;

  @Column({ type: 'varchar', nullable: true })
  actorId: string | null;

  @Column('varchar')
  action: string;

  @Column('varchar')
  subjectType: string;

  @Column('varchar')
  subjectId: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  requestId: string | null;
}
