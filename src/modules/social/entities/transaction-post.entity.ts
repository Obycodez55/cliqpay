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

export const POST_VISIBILITIES = ['public', 'private'] as const;
export type PostVisibility = (typeof POST_VISIBILITIES)[number];

// The partial indexes also carry `created_at DESC, id DESC` in the migration;
// an entity can't express descending columns.
@Entity('transaction_posts')
@Unique('UQ_transaction_posts_transaction_id', ['transactionId'])
@Check(
  'CHK_transaction_posts_visibility',
  inList('visibility', POST_VISIBILITIES),
)
@Check(
  'CHK_transaction_posts_requested_visibility',
  inList('requested_visibility', POST_VISIBILITIES),
)
@Index(
  'IDX_transaction_posts_sender_public',
  ['senderUserId', 'createdAt', 'id'],
  { where: `"visibility" = 'public' AND "hidden_by_recipient" = false` },
)
@Index(
  'IDX_transaction_posts_recipient_public',
  ['recipientUserId', 'createdAt', 'id'],
  { where: `"visibility" = 'public' AND "hidden_by_recipient" = false` },
)
export class TransactionPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  transactionId: string;

  @Column('uuid')
  senderUserId: string;

  @Column('uuid')
  recipientUserId: string;

  @Column({ type: 'varchar', nullable: true })
  note: string | null;

  @Column('varchar')
  visibility: PostVisibility;

  @Column('varchar')
  requestedVisibility: PostVisibility;

  @Column('boolean', { default: false })
  hiddenByRecipient: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
