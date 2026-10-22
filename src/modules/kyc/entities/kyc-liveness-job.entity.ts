import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  KycIdentityType,
  KycVerificationAttempt,
} from './kyc-verification-attempt.entity';

export type KycLivenessJobStatus = 'pending' | 'passed' | 'failed';

@Entity('kyc_liveness_jobs')
@Index('IDX_kyc_liveness_jobs_provider_job_id', ['providerJobId'])
export class KycLivenessJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  attemptId: string;

  @ManyToOne(() => KycVerificationAttempt, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'attempt_id' })
  attempt: KycVerificationAttempt;

  @Column('varchar')
  identityType: KycIdentityType;

  @Column({ type: 'varchar', nullable: true })
  providerJobId: string | null;

  @Column('varchar')
  status: KycLivenessJobStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
