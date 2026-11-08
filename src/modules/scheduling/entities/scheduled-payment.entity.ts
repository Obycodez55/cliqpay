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

export const SCHEDULE_TARGET_TYPES = ['user'] as const;
export type ScheduleTargetType = (typeof SCHEDULE_TARGET_TYPES)[number];

export const SCHEDULE_STATUSES = ['active', 'cancelled', 'completed'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_VISIBILITIES = ['public', 'private'] as const;
export type ScheduleVisibility = (typeof SCHEDULE_VISIBILITIES)[number];

export const bigintTransformer = {
  to: (v: bigint) => v,
  from: (v: string) => BigInt(v),
};

// `userId` and `recipientUserId` are cross-module references: plain columns,
// no FK, no relation. `startDate` is a Lagos calendar date, kept as the
// 'YYYY-MM-DD' string Postgres returns. `nextRunAt` is null once no further
// run is due.
@Entity('scheduled_payments')
@Check(
  'CHK_scheduled_payments_target_type',
  inList('target_type', SCHEDULE_TARGET_TYPES),
)
@Check('CHK_scheduled_payments_status', inList('status', SCHEDULE_STATUSES))
@Check(
  'CHK_scheduled_payments_visibility',
  inList('visibility', SCHEDULE_VISIBILITIES),
)
@Unique('UQ_scheduled_payments_user_id_reference', ['userId', 'reference'])
@Index('IDX_scheduled_payments_next_run_at', ['nextRunAt'], {
  where: `"status" = 'active'`,
})
export class ScheduledPayment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column('varchar')
  reference: string;

  @Column('varchar')
  targetType: ScheduleTargetType;

  @Column('uuid')
  recipientUserId: string;

  @Column('bigint', { transformer: bigintTransformer })
  amount: bigint;

  @Column('varchar')
  currency: string;

  @Column('varchar', { length: 500, nullable: true })
  note: string | null;

  @Column('varchar')
  visibility: ScheduleVisibility;

  @Column('date')
  startDate: string;

  @Column('int')
  runOffsetMinutes: number;

  @Column('varchar')
  status: ScheduleStatus;

  @Column('int', { default: 1 })
  nextRunNumber: number;

  @Column({ type: 'timestamptz', nullable: true })
  nextRunAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
