import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { KycAddress } from '../providers/kyc-provider.interface';

export interface KycAddresses {
  bvn?: KycAddress;
  nin?: KycAddress;
}

@Entity('kyc_verifications')
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

  @Column({ type: 'varchar', nullable: true })
  verifiedLegalName: string | null;

  @Column({ type: 'boolean', default: false })
  livenessVerified: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
