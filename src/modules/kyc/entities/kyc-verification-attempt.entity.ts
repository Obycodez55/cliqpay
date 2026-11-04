import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const KYC_IDENTITY_TYPES = ['bvn', 'nin'] as const;
export type KycIdentityType = (typeof KYC_IDENTITY_TYPES)[number];

@Entity('kyc_verification_attempts')
@Check(
  'CHK_kyc_verification_attempts_identity_type',
  inList('identity_type', KYC_IDENTITY_TYPES),
)
@Index('IDX_kyc_verification_attempts_user_identity_created', [
  'userId',
  'identityType',
  'createdAt',
])
export class KycVerificationAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column('varchar')
  identityType: KycIdentityType;

  @Column('boolean')
  succeeded: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
