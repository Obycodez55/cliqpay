import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const MFA_METHOD_TYPES = ['email', 'totp'] as const;
export type MfaMethodType = (typeof MFA_METHOD_TYPES)[number];
export const MFA_METHOD_STATUSES = ['pending', 'active'] as const;
export type MfaMethodStatus = (typeof MFA_METHOD_STATUSES)[number];

@Entity('mfa_methods')
@Check('CHK_mfa_methods_type', inList('type', MFA_METHOD_TYPES))
@Check('CHK_mfa_methods_status', inList('status', MFA_METHOD_STATUSES))
@Unique('UQ_mfa_methods_user_id_type', ['userId', 'type'])
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
