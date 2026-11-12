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
import { User } from './user.entity';

export const RESTRICTION_REASONS = [
  'dispute',
  'fraud',
  'self_lock',
  'watchlist',
  'sanctions',
] as const;
export type RestrictionReason = (typeof RESTRICTION_REASONS)[number];

export const RESTRICTION_SCOPES = ['outbound', 'all'] as const;
export type RestrictionScope = (typeof RESTRICTION_SCOPES)[number];

@Entity('account_restrictions')
@Check('CHK_account_restrictions_reason', inList('reason', RESTRICTION_REASONS))
@Check('CHK_account_restrictions_scope', inList('scope', RESTRICTION_SCOPES))
@Index('UQ_account_restrictions_open', ['userId', 'reason', 'sourceId'], {
  unique: true,
  where: '"lifted_at" IS NULL',
})
@Index('IDX_account_restrictions_open_user', ['userId'], {
  where: '"lifted_at" IS NULL',
})
export class AccountRestriction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column('varchar')
  reason: RestrictionReason;

  @Column('varchar')
  scope: RestrictionScope;

  @Column('uuid')
  sourceId: string;

  @Column({ type: 'varchar', nullable: true })
  note: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  liftedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  liftedBy: string | null;
}
