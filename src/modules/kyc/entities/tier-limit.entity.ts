import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { KycTier } from '../../users/users.service';

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
