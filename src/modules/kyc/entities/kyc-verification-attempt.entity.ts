import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type KycIdentityType = 'bvn' | 'nin';

@Entity('kyc_verification_attempts')
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
