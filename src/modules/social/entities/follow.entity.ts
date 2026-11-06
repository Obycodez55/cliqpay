import { Check, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('follows')
@Check('CHK_follows_not_self', '"follower_user_id" <> "followee_user_id"')
@Index('IDX_follows_follower_created', [
  'followerUserId',
  'createdAt',
  'followeeUserId',
])
@Index('IDX_follows_followee_created', [
  'followeeUserId',
  'createdAt',
  'followerUserId',
])
export class Follow {
  @PrimaryColumn('uuid')
  followerUserId: string;

  @PrimaryColumn('uuid')
  followeeUserId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
