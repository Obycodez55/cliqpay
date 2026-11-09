import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const KYC_TIERS = ['tier0', 'tier1', 'tier2', 'tier3'] as const;
export type KycTier = (typeof KYC_TIERS)[number];

// Identity only — no credential fields. Those live on auth's `Credential`
// (1:1 via a plain `userId` column, no FK — see ADR-0005) since `auth` and
// `users` are separate core modules.
@Entity('users')
@Check('CHK_users_kyc_tier', inList('kyc_tier', KYC_TIERS))
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  email: string;

  @Column({ type: 'varchar', unique: true })
  phone: string;

  @Column({ type: 'varchar', unique: true })
  username: string;

  @Column({ type: 'timestamptz', nullable: true })
  usernameChangedAt: Date | null;

  @Column({ type: 'varchar' })
  firstName: string;

  @Column({ type: 'varchar' })
  lastName: string;

  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  // Set by change-email (issue #9) between its verification-code send and
  // confirm — `email` itself never changes until confirm succeeds, so the
  // account is never live on an unverified address.
  @Column({ type: 'varchar', nullable: true })
  pendingEmail: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  phoneVerifiedAt: Date | null;

  // Set by change-phone (issue #10) between its verification-code send and
  // confirm — `phone` itself never changes until confirm succeeds, mirroring
  // pendingEmail (issue #9).
  @Column({ type: 'varchar', nullable: true })
  pendingPhone: string | null;

  @Column({ type: 'varchar', default: 'tier0' })
  kycTier: KycTier;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
