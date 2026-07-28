import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DeviceMetadata } from '../internal/device-metadata.util';

@Entity('trusted_devices')
export class TrustedDevice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Cross-module reference to users.User — no FK, no relation decorator
  // (ADR-0005, amending ADR-0002). See DropUserForeignKeys migration.
  @Index()
  @Column('uuid')
  userId: string;

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
