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
import { TrustedDevice } from './trusted-device.entity';

export type SessionStatus = 'active' | 'revoked';

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Cross-module reference to users.User — no FK, no relation decorator
  // (ADR-0005, amending ADR-0002's same-module-only relation rule). Was a
  // real FK with a `user` relation before `User` moved to its own module;
  // see the DropUserForeignKeys migration.
  @Index()
  @Column('uuid')
  userId: string;

  @Column({ type: 'varchar', unique: true })
  currentTokenHash: string;

  @Index()
  @Column({ type: 'varchar', nullable: true })
  previousTokenHash: string | null;

  @Column({ type: 'varchar', default: 'active' })
  status: SessionStatus;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  trustedDeviceId: string | null;

  @ManyToOne(() => TrustedDevice)
  @JoinColumn({ name: 'trusted_device_id' })
  trustedDevice?: TrustedDevice;

  @Column({ type: 'jsonb' })
  device: DeviceMetadata;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz' })
  lastUsedAt: Date;
}
