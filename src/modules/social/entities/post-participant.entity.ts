import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';
import { Post } from './post.entity';

export const PARTICIPANT_ROLES = ['author', 'counterparty', 'member'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

// The feed index also carries `post_created_at DESC, post_id DESC` in the
// migration; an entity can't express descending columns.
@Entity('post_participants')
@Check('CHK_post_participants_role', inList('role', PARTICIPANT_ROLES))
@Index('IDX_post_participants_feed', ['userId', 'postCreatedAt', 'postId'], {
  where: `"post_is_public"`,
})
export class PostParticipant {
  @PrimaryColumn('uuid')
  postId: string;

  @ManyToOne(() => Post)
  @JoinColumn({ name: 'post_id' })
  post: Post;

  @PrimaryColumn('uuid')
  userId: string;

  @Column('varchar')
  role: ParticipantRole;

  @Column('boolean', { default: false })
  hidden: boolean;

  @Column({ type: 'timestamptz' })
  postCreatedAt: Date;

  @Column('boolean')
  postIsPublic: boolean;
}
