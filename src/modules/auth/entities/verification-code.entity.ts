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

// No uniqueness constraint on codeHash — a future OTP-shaped purpose (a
// short numeric code) has low enough entropy that a cross-user collision is
// plausible, same reasoning as MfaChallenge.codeHash.
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

  // timestamptz, not timestamp — the 60s cooldown in
  // VerificationCodeService does sub-minute arithmetic on these columns,
  // which a bare `timestamp` gets wrong once the server isn't running in
  // UTC (confirmed: a full hour off under Africa/Lagos). Other tables in
  // this schema still use plain `timestamp` — same latent exposure, out of
  // scope here.
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
