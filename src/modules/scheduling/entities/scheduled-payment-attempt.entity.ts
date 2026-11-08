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
import { ScheduledPaymentRun } from './scheduled-payment-run.entity';

export const ATTEMPT_KINDS = ['attempt'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const ATTEMPT_OUTCOMES = ['succeeded', 'failed'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const FAILURE_CODES = [
  'insufficient_balance',
  'daily_limit_exceeded',
  'recipient_cap',
  'blocked',
  'recipient_unavailable',
  'sender_frozen',
  'infrastructure',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

// Append-only, enforced by a trigger. A row is written once the attempt's
// outcome is known, so an attempt that crashed mid-flight leaves no row and
// is retried under the same number and reference.
@Entity('scheduled_payment_attempts')
@Check('CHK_scheduled_payment_attempts_kind', inList('kind', ATTEMPT_KINDS))
@Check(
  'CHK_scheduled_payment_attempts_outcome',
  inList('outcome', ATTEMPT_OUTCOMES),
)
@Check(
  'CHK_scheduled_payment_attempts_failure_code',
  `"failure_code" IS NULL OR ${inList('failure_code', FAILURE_CODES)}`,
)
export class ScheduledPaymentAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  runId: string;

  @ManyToOne(() => ScheduledPaymentRun)
  @JoinColumn({ name: 'run_id' })
  run: ScheduledPaymentRun;

  @Column('varchar')
  kind: AttemptKind;

  @Column('int')
  attemptNumber: number;

  @Column('varchar')
  reference: string;

  @Column('varchar')
  outcome: AttemptOutcome;

  @Column('varchar', { nullable: true })
  failureCode: FailureCode | null;

  @Column('uuid', { nullable: true })
  transactionId: string | null;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
