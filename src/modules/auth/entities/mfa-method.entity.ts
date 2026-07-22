import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

export type MfaMethodType = 'email' | 'totp';
export type MfaMethodStatus = 'pending' | 'active';

@Entity('mfa_methods')
@Index(['userId', 'type'], { unique: true })
export class MfaMethod {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'varchar' })
  type: MfaMethodType;

  @Column({ type: 'varchar', default: 'pending' })
  status: MfaMethodStatus;

  // Only set for `type: 'totp'` — AES-256-GCM ciphertext, see
  // internal/secrets.util.ts. Null for the email method, which has
  // no secret of its own (codes are one-time and delivered, not shared).
  @Column({ type: 'varchar', nullable: true })
  secretCiphertext: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
