import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';
import { Post } from './post.entity';

export const REACTIONS = [
  'heart',
  'laugh',
  'wow',
  'fire',
  'clap',
  'pray',
] as const;
export type Reaction = (typeof REACTIONS)[number];

@Entity('post_reactions')
@Check('CHK_post_reactions_reaction', inList('reaction', REACTIONS))
export class PostReaction {
  @PrimaryColumn('uuid')
  postId: string;

  @ManyToOne(() => Post)
  @JoinColumn({ name: 'post_id' })
  post: Post;

  @PrimaryColumn('uuid')
  userId: string;

  @Column('varchar')
  reaction: Reaction;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
