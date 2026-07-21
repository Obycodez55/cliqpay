import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
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

  // Nullable, unwired until the MFA slice (issue #4) — see
  // docs/architecture.md §3.7. No FK: trusted_devices doesn't exist yet.
  @Column({ type: 'uuid', nullable: true })
  trustedDeviceId: string | null;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp' })
  lastUsedAt: Date;
}
