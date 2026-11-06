import { Check, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('blocks')
@Check('CHK_blocks_not_self', '"blocker_user_id" <> "blocked_user_id"')
@Index('IDX_blocks_blocker_created', [
  'blockerUserId',
  'createdAt',
  'blockedUserId',
])
export class Block {
  @PrimaryColumn('uuid')
  blockerUserId: string;

  @PrimaryColumn('uuid')
  blockedUserId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
