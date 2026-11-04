import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';
import {
  KYC_IDENTITY_TYPES,
  KycIdentityType,
  KycVerificationAttempt,
} from './kyc-verification-attempt.entity';

export const KYC_LIVENESS_JOB_STATUSES = [
  'pending',
  'passed',
  'failed',
] as const;
export type KycLivenessJobStatus = (typeof KYC_LIVENESS_JOB_STATUSES)[number];

@Entity('kyc_liveness_jobs')
@Check(
  'CHK_kyc_liveness_jobs_identity_type',
  inList('identity_type', KYC_IDENTITY_TYPES),
)
@Check(
  'CHK_kyc_liveness_jobs_status',
  inList('status', KYC_LIVENESS_JOB_STATUSES),
)
@Index('IDX_kyc_liveness_jobs_provider_job_id', ['providerJobId'])
@Index('UQ_kyc_liveness_jobs_user_pending', ['userId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
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

  @Column({ type: 'int', default: 0 })
  pollFailures: number;

  @Column('varchar')
  status: KycLivenessJobStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
