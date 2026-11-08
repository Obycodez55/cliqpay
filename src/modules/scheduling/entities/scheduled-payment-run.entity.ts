import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';
import {
  ScheduleTargetType,
  ScheduleVisibility,
  SCHEDULE_TARGET_TYPES,
  SCHEDULE_VISIBILITIES,
  ScheduledPayment,
  bigintTransformer,
} from './scheduled-payment.entity';

export const RUN_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// Amount, target, note and visibility are a snapshot of the schedule at the
// moment the sweep created the run, so every attempt pays the same thing.
// `transactionId` is ledger's transactions.id: cross-module, no FK.
@Entity('scheduled_payment_runs')
@Check('CHK_scheduled_payment_runs_status', inList('status', RUN_STATUSES))
@Check(
  'CHK_scheduled_payment_runs_target_type',
  inList('target_type', SCHEDULE_TARGET_TYPES),
)
@Check(
  'CHK_scheduled_payment_runs_visibility',
  inList('visibility', SCHEDULE_VISIBILITIES),
)
@Unique('UQ_scheduled_payment_runs_scheduled_payment_id_run_number', [
  'scheduledPaymentId',
  'runNumber',
])
export class ScheduledPaymentRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  scheduledPaymentId: string;

  @ManyToOne(() => ScheduledPayment)
  @JoinColumn({ name: 'scheduled_payment_id' })
  scheduledPayment: ScheduledPayment;

  @Column('int')
  runNumber: number;

  @Column({ type: 'timestamptz' })
  dueAt: Date;

  @Column('varchar')
  status: RunStatus;

  @Column('bigint', { transformer: bigintTransformer })
  amount: bigint;

  @Column('varchar')
  targetType: ScheduleTargetType;

  @Column('uuid')
  recipientUserId: string;

  @Column('varchar', { length: 500, nullable: true })
  note: string | null;

  @Column('varchar')
  visibility: ScheduleVisibility;

  @Column('int', { default: 0 })
  attemptCount: number;

  @Column('uuid', { nullable: true })
  transactionId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
