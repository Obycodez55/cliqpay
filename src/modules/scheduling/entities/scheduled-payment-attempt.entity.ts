import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';
import { ScheduledPaymentRun } from './scheduled-payment-run.entity';

export const ATTEMPT_KINDS = [
  'attempt',
  'missed',
  'settled',
  'reversed',
] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const ATTEMPT_OUTCOMES = ['succeeded', 'failed', 'settling'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const FAILURE_CODES = [
  'insufficient_balance',
  'daily_limit_exceeded',
  'recipient_cap',
  'blocked',
  'recipient_unavailable',
  'sender_frozen',
  'bank_account_removed',
  'payout_rejected',
  'amount_below_minimum',
  'sender_unverified',
  'infrastructure',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

// Append-only, enforced by a trigger. A row is written once the attempt's
// outcome is known, so an attempt that crashed mid-flight leaves no row and
// is retried under the same number and reference. A `missed` row records a
// run that was never tried, so it has no number, reference, outcome or start.
// A bank run's payout settles later: the attempt row says `settling`, and a
// `settled` or `reversed` row follows with the same number and reference.
@Entity('scheduled_payment_attempts')
@Check('CHK_scheduled_payment_attempts_kind', inList('kind', ATTEMPT_KINDS))
@Check(
  'CHK_scheduled_payment_attempts_outcome',
  inList('outcome', ATTEMPT_OUTCOMES),
)
@Check(
  'CHK_scheduled_payment_attempts_attempt_fields',
  `"kind" <> 'attempt' OR ("attempt_number" IS NOT NULL AND "reference" IS NOT NULL AND "outcome" IS NOT NULL AND "started_at" IS NOT NULL)`,
)
@Check(
  'CHK_scheduled_payment_attempts_failure_code',
  `"failure_code" IS NULL OR ${inList('failure_code', FAILURE_CODES)}`,
)
@Index('IDX_scheduled_payment_attempts_run_id', ['runId'])
@Index(
  'UQ_scheduled_payment_attempts_run_id_attempt_number',
  ['runId', 'attemptNumber'],
  { unique: true, where: `"kind" = 'attempt'` },
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

  @Column({ type: 'int', nullable: true })
  attemptNumber: number | null;

  @Column({ type: 'varchar', nullable: true })
  reference: string | null;

  @Column({ type: 'varchar', nullable: true })
  outcome: AttemptOutcome | null;

  @Column('varchar', { nullable: true })
  failureCode: FailureCode | null;

  @Column('uuid', { nullable: true })
  transactionId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
