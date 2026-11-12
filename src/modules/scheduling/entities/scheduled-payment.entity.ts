import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';
import { IntervalUnit } from '../internal/run-time';

export const SCHEDULE_TARGET_TYPES = ['user', 'bank_account'] as const;
export type ScheduleTargetType = (typeof SCHEDULE_TARGET_TYPES)[number];

export const SCHEDULE_STATUSES = [
  'active',
  'paused',
  'cancelled',
  'completed',
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_VISIBILITIES = ['public', 'private'] as const;
export type ScheduleVisibility = (typeof SCHEDULE_VISIBILITIES)[number];

// Exactly the target column matching `target_type` is set, and visibility
// exists only for a user target: a bank payout is never in the feed.
export const TARGET_COLUMNS_CHECK = `("target_type" = 'user' AND "recipient_user_id" IS NOT NULL AND "bank_account_id" IS NULL AND "visibility" IS NOT NULL) OR ("target_type" = 'bank_account' AND "bank_account_id" IS NOT NULL AND "recipient_user_id" IS NULL AND "visibility" IS NULL)`;

export const bigintTransformer = {
  to: (v: bigint) => v,
  from: (v: string) => BigInt(v),
};

// `startDate` and `endDate` are Lagos calendar dates, kept as the
// 'YYYY-MM-DD' strings Postgres returns; `startDate` is the date of run
// `anchorRunNumber`.
@Entity('scheduled_payments')
@Check(
  'CHK_scheduled_payments_target_type',
  inList('target_type', SCHEDULE_TARGET_TYPES),
)
@Check('CHK_scheduled_payments_target', TARGET_COLUMNS_CHECK)
@Check('CHK_scheduled_payments_status', inList('status', SCHEDULE_STATUSES))
@Check(
  'CHK_scheduled_payments_visibility',
  inList('visibility', SCHEDULE_VISIBILITIES),
)
@Check(
  'CHK_scheduled_payments_interval',
  `("interval_unit" IS NULL AND "interval_count" IS NULL) OR ("interval_unit" = 'day' AND "interval_count" IS NOT NULL AND "interval_count" BETWEEN 1 AND 365) OR ("interval_unit" = 'week' AND "interval_count" IS NOT NULL AND "interval_count" BETWEEN 1 AND 52) OR ("interval_unit" = 'month' AND "interval_count" IS NOT NULL AND "interval_count" BETWEEN 1 AND 12)`,
)
@Check(
  'CHK_scheduled_payments_end_condition',
  `"end_date" IS NULL OR "max_runs" IS NULL`,
)
@Check(
  'CHK_scheduled_payments_max_runs',
  `"max_runs" IS NULL OR "max_runs" BETWEEN 1 AND 366`,
)
@Unique('UQ_scheduled_payments_user_id_reference', ['userId', 'reference'])
@Index('IDX_scheduled_payments_next_run_at', ['nextRunAt'], {
  where: `"status" = 'active'`,
})
@Index('IDX_scheduled_payments_user_id_created_at', [
  'userId',
  'createdAt',
  'id',
])
export class ScheduledPayment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column('varchar')
  reference: string;

  @Column('varchar')
  targetType: ScheduleTargetType;

  @Column({ type: 'uuid', nullable: true })
  recipientUserId: string | null;

  @Column({ type: 'uuid', nullable: true })
  bankAccountId: string | null;

  @Column('bigint', { transformer: bigintTransformer })
  amount: bigint;

  @Column('varchar')
  currency: string;

  @Column('varchar', { length: 500, nullable: true })
  note: string | null;

  @Column({ type: 'varchar', nullable: true })
  visibility: ScheduleVisibility | null;

  @Column({ type: 'jsonb', nullable: true })
  riskAcknowledgement: { codes: string[]; acknowledgedAt: string } | null;

  @Column('date')
  startDate: string;

  @Column('int', { default: 1 })
  anchorRunNumber: number;

  @Column({ type: 'varchar', nullable: true })
  intervalUnit: IntervalUnit | null;

  @Column({ type: 'int', nullable: true })
  intervalCount: number | null;

  @Column({ type: 'date', nullable: true })
  endDate: string | null;

  @Column({ type: 'int', nullable: true })
  maxRuns: number | null;

  @Column('int')
  runOffsetMinutes: number;

  @Column('varchar')
  status: ScheduleStatus;

  @Column('int', { default: 1 })
  nextRunNumber: number;

  @Column('int', { default: 0 })
  consecutiveFailures: number;

  // 'user', a permanent failure code, or 'consecutive_failures'; null unless
  // the schedule is paused.
  @Column({ type: 'varchar', nullable: true })
  pausedReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  nextRunAt: Date | null;

  // The Lagos date of the run the sender was last warned about, so the
  // evening job never warns twice for the same run.
  @Column({ type: 'date', nullable: true })
  lastRemindedRunDate: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
