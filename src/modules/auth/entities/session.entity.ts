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
import { User } from './user.entity';

export type SessionStatus = 'active' | 'revoked';

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Plain column, not just a relation artifact — AuthService reads/writes
  // this directly (see auth.service.ts). `user` below maps the same
  // `user_id` column as an explicit, same-module FK (real constraint in
  // CreateSessions migration); it's lazy — nothing eager-loads it, a query
  // has to ask for `relations: ['user']` to get it populated.
  @Index()
  @Column('uuid')
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User;

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

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp' })
  lastUsedAt: Date;
}
