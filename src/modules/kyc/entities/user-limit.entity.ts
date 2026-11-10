import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

const bigintTransformer = {
  to: (v: bigint | null) => v,
  from: (v: string | null) => (v === null ? null : BigInt(v)),
};

// A customer-set daily outflow limit. A raise is stored as pending and
// counts only once `pendingEffectiveAt` has passed; nothing applies it, so
// readers must resolve the effective value themselves.
@Entity('user_limits')
@Unique('UQ_user_limits_user_id', ['userId'])
@Check(
  'CHK_user_limits_amounts_non_negative',
  `("daily_outflow_limit_minor" IS NULL OR "daily_outflow_limit_minor" >= 0) AND ("pending_daily_outflow_limit_minor" IS NULL OR "pending_daily_outflow_limit_minor" >= 0)`,
)
@Check(
  'CHK_user_limits_pending_pair',
  `("pending_daily_outflow_limit_minor" IS NULL) = ("pending_effective_at" IS NULL)`,
)
export class UserLimit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  dailyOutflowLimitMinor: bigint | null;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  pendingDailyOutflowLimitMinor: bigint | null;

  @Column({ type: 'timestamptz', nullable: true })
  pendingEffectiveAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
