import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

export type VerificationPurpose =
  | 'email_verification'
  | 'phone_verification'
  | 'password_reset';

// One table, one create/verify/rate-limit implementation shared across all
// three purposes (see VerificationCodeService) — email verification is the
// only purpose this issue actually dispatches; phone verification (#6) and
// password reset (#7) reuse the same shape rather than getting their own
// tables. No uniqueness constraint on codeHash: a future OTP-shaped purpose
// (phone verification's short numeric code) has low enough entropy that a
// cross-user collision is plausible, same reasoning as MfaChallenge.codeHash.
@Entity('verification_codes')
@Index(['userId', 'purpose'])
export class VerificationCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column('varchar')
  purpose: VerificationPurpose;

  @Index()
  @Column('varchar')
  codeHash: string;

  // timestamptz, not timestamp — this table's own rate-limit logic
  // (VerificationCodeService.assertResendAllowed) does sub-minute arithmetic
  // directly on these columns (a 60s cooldown), which a bare `timestamp`
  // column gets systematically wrong by the server process's UTC offset once
  // TZ isn't UTC (confirmed against a real Postgres instance under
  // Africa/Lagos, UTC+1: values round-tripped exactly one hour off). Plain
  // `timestamp` elsewhere in this schema (Session.expiresAt,
  // MfaChallenge.expiresAt, User.lockedUntil, etc.) has the same latent
  // exposure but is out of scope for this table's migration to correct.
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
