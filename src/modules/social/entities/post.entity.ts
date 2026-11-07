import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { inList } from '../../../database/check.util';

export const POST_VISIBILITIES = ['public', 'private'] as const;
export type PostVisibility = (typeof POST_VISIBILITIES)[number];

export const POST_KINDS = ['transfer'] as const;
export type PostKind = (typeof POST_KINDS)[number];

@Entity('posts')
@Check('CHK_posts_kind', inList('kind', POST_KINDS))
@Check('CHK_posts_visibility', inList('visibility', POST_VISIBILITIES))
@Check(
  'CHK_posts_requested_visibility',
  inList('requested_visibility', POST_VISIBILITIES),
)
export class Post {
  @PrimaryColumn('uuid')
  id: string;

  @Column('varchar')
  kind: PostKind;

  @Column('uuid')
  authorUserId: string;

  @Column({ type: 'varchar', nullable: true })
  note: string | null;

  @Column('varchar')
  visibility: PostVisibility;

  @Column('varchar')
  requestedVisibility: PostVisibility;

  @Column('boolean')
  isPublic: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
