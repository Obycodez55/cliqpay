import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('notifications')
@Index('IDX_notifications_user_id_created_at', ['userId', 'createdAt'])
@Index('IDX_notifications_user_id_unread', ['userId'], {
  where: 'read_at IS NULL',
})
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  userId: string;

  @Column('varchar')
  type: string;

  @Column({ type: 'jsonb', default: {} })
  data: Record<string, unknown>;

  @Column('varchar')
  title: string;

  @Column('text')
  body: string;

  @Column('varchar')
  dedupeKey: string;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
