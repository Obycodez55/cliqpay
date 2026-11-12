import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const DEVICE_CHALLENGE_PURPOSES = [
  'login',
  'refresh',
  'register',
] as const;
export type DeviceChallengePurpose = (typeof DEVICE_CHALLENGE_PURPOSES)[number];

@Entity('device_challenges')
@Check(
  'CHK_device_challenges_purpose',
  inList('purpose', DEVICE_CHALLENGE_PURPOSES),
)
export class DeviceChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column('varchar')
  nonceHash: string;

  @Column('varchar')
  deviceId: string;

  @Column('varchar')
  purpose: DeviceChallengePurpose;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
