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
import { MfaMethod } from './mfa-method.entity';

export const MFA_CHALLENGE_STATUSES = [
  'pending',
  'verified',
  'failed',
] as const;
export type MfaChallengeStatus = (typeof MFA_CHALLENGE_STATUSES)[number];

@Entity('mfa_challenges')
@Check('CHK_mfa_challenges_status', inList('status', MFA_CHALLENGE_STATUSES))
export class MfaChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  methodId: string;

  @ManyToOne(() => MfaMethod)
  @JoinColumn({ name: 'method_id' })
  method?: MfaMethod;

  // Only set for an email challenge — SHA-256 of the sent code (see
  // mfa.service.ts). Null for a TOTP challenge, which has no server-issued
  // code to hash: verification recomputes the TOTP live from the method's
  // own secret.
  @Column({ type: 'varchar', nullable: true })
  codeHash: string | null;

  @Column({ type: 'varchar', default: 'pending' })
  status: MfaChallengeStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
