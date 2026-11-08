import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';
import { ScheduledPayment } from './scheduled-payment.entity';

export const CHANGE_KINDS = [
  'created',
  'paused',
  'resumed',
  'cancelled',
  'completed',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_ACTORS = ['user', 'system'] as const;
export type ChangeActor = (typeof CHANGE_ACTORS)[number];

// Append-only, enforced by a trigger.
@Entity('scheduled_payment_changes')
@Check('CHK_scheduled_payment_changes_kind', inList('kind', CHANGE_KINDS))
@Check('CHK_scheduled_payment_changes_actor', inList('actor', CHANGE_ACTORS))
export class ScheduledPaymentChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  scheduledPaymentId: string;

  @ManyToOne(() => ScheduledPayment)
  @JoinColumn({ name: 'scheduled_payment_id' })
  scheduledPayment: ScheduledPayment;

  @Column('varchar')
  kind: ChangeKind;

  @Column('varchar')
  actor: ChangeActor;

  @Column({ type: 'varchar', nullable: true })
  reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
