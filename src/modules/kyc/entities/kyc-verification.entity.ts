import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { KycAddress } from '../providers/kyc-provider.interface';

export interface KycAddresses {
  bvn?: KycAddress;
  nin?: KycAddress;
}

export interface KycIdentitySource {
  legalName?: string;
  dateOfBirth?: string;
}

export interface KycIdentities {
  bvn?: KycIdentitySource;
  nin?: KycIdentitySource;
}

@Entity('kyc_verifications')
@Unique('UQ_kyc_verifications_user_id', ['userId'])
@Index('UQ_kyc_verifications_bvn_hash_partial', ['bvnHash'], {
  unique: true,
  where: `"bvn_hash" IS NOT NULL`,
})
@Index('UQ_kyc_verifications_nin_hash_partial', ['ninHash'], {
  unique: true,
  where: `"nin_hash" IS NOT NULL`,
})
export class KycVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', nullable: true })
  bvnCiphertext: string | null;

  @Column({ type: 'varchar', nullable: true })
  bvnHash: string | null;

  @Column({ type: 'varchar', nullable: true })
  ninCiphertext: string | null;

  @Column({ type: 'varchar', nullable: true })
  ninHash: string | null;

  @Column({ type: 'jsonb', nullable: true })
  address: KycAddresses | null;

  @Column({ type: 'jsonb', nullable: true })
  identity: KycIdentities | null;

  @Column({ type: 'varchar', nullable: true })
  verifiedLegalName: string | null;

  @Column({ type: 'boolean', default: false })
  livenessVerified: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
