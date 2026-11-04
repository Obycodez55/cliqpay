import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';
import { KYC_TIERS, KycTier } from '../../users/users.service';

const bigintTransformer = {
  to: (v: bigint) => v,
  from: (v: string) => BigInt(v),
};

// Nullable (Tier 3 has no cap), unlike the transformer above.
const nullableBigintTransformer = {
  to: (v: bigint | null) => v,
  from: (v: string | null) => (v === null ? null : BigInt(v)),
};

@Entity('tier_limits')
@Check('CHK_tier_limits_tier', inList('tier', KYC_TIERS))
@Check(
  'CHK_tier_limits_daily_debit_limit_non_negative',
  `"daily_debit_limit_minor" >= 0`,
)
@Check(
  'CHK_tier_limits_balance_cap_non_negative',
  `"balance_cap_minor" IS NULL OR "balance_cap_minor" >= 0`,
)
@Unique('UQ_tier_limits_tier_currency', ['tier', 'currency'])
export class TierLimit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar')
  tier: KycTier;

  @Column('varchar')
  currency: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  dailyDebitLimitMinor: bigint;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: nullableBigintTransformer,
  })
  balanceCapMinor: bigint | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
