import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type VerificationPurpose =
  | 'email_verification'
  | 'phone_verification'
  | 'password_reset';

// No uniqueness constraint on codeHash — a future OTP-shaped purpose (a
// short numeric code) has low enough entropy that a cross-user collision is
// plausible, same reasoning as MfaChallenge.codeHash.
//
// Cross-module reference to users.User (userId) — no FK, no relation
// decorator (ADR-0005, amending ADR-0002). See DropUserForeignKeys migration.
@Entity('verification_codes')
@Index(['userId', 'purpose'])
export class VerificationCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  userId: string;

  @Column('varchar')
  purpose: VerificationPurpose;

  @Index()
  @Column('varchar')
  codeHash: string;

  // timestamptz, not timestamp — see ADR-0004.
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
