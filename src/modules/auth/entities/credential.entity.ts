import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// IAM mechanics split off `users.User` (see ADR-0005) — password, PIN, and
// lockout state, 1:1 with a `users` row via a plain `userId` column. No FK:
// `users` is a separate core module (cross-module reference, per ADR-0002).
// `userId` is unique to enforce the 1:1 cardinality locally.
@Entity('credentials')
export class Credential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  userId: string;

  @Column('varchar')
  passwordHash: string;

  @Column({ type: 'varchar', nullable: true })
  transactionPinHash: string | null;

  @Column({ type: 'int', default: 0 })
  failedLoginAttempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
