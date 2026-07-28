import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MfaMethodType = 'email' | 'totp';
export type MfaMethodStatus = 'pending' | 'active';

@Entity('mfa_methods')
@Index(['userId', 'type'], { unique: true })
export class MfaMethod {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Cross-module reference to users.User — no FK, no relation decorator
  // (ADR-0005, amending ADR-0002). See DropUserForeignKeys migration.
  @Index()
  @Column('uuid')
  userId: string;

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
