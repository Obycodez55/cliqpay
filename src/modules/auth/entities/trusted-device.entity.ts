import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';
import { DeviceMetadata } from '../internal/device-metadata.util';

export const ATTESTATION_RESULTS = ['passed', 'failed', 'unavailable'] as const;
export type AttestationResult = (typeof ATTESTATION_RESULTS)[number];

@Entity('trusted_devices')
@Check(
  'CHK_trusted_devices_attestation_result',
  inList('attestation_result', ATTESTATION_RESULTS),
)
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
  @Index()
  @Column('varchar')
  deviceId: string;

  // Base64 X.509 SPKI of the device's ECDSA P-256 key; null only when
  // DEVICE_KEY_REQUIRED is off.
  @Column({ type: 'text', nullable: true })
  publicKey: string | null;

  @Column({ type: 'varchar', default: 'unavailable' })
  attestationResult: AttestationResult;

  @Column({ type: 'jsonb' })
  device: DeviceMetadata;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz' })
  lastUsedAt: Date;
}
