import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DeviceMetadata } from '../internal/device-metadata.util';
import { User } from './user.entity';

@Entity('trusted_devices')
export class TrustedDevice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User;

  // SHA-256, not bcrypt — same reasoning as Session's refresh-token hashes
  // (docs/architecture.md §3.7): a high-entropy random value, not a human
  // secret.
  @Column({ type: 'varchar', unique: true })
  tokenHash: string;

  // Captured once, at issuance — see ADR-0003. Same jsonb shape as Session's
  // own `device` column, deliberately, rather than a separate
  // device-fingerprint format.
  @Column({ type: 'jsonb' })
  device: DeviceMetadata;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz' })
  lastUsedAt: Date;
}
