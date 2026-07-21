import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MfaMethod } from './mfa-method.entity';

export type MfaChallengeStatus = 'pending' | 'verified' | 'failed';

@Entity('mfa_challenges')
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
  // internal/mfa.service.ts). Null for a TOTP challenge, which has no
  // server-issued code to hash: verification recomputes the TOTP live from
  // the method's own secret.
  @Column({ type: 'varchar', nullable: true })
  codeHash: string | null;

  @Column({ type: 'varchar', default: 'pending' })
  status: MfaChallengeStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
