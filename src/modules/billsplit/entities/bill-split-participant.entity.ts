import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { BillSplit } from './bill-split.entity';

const bigintTransformer = {
  to: (v: bigint) => v,
  from: (v: string) => BigInt(v),
};

// `userId` and `moneyRequestId` are cross-module references (users and
// transfers' money_requests): plain columns, no FK, no relation (ADR-0002).
// There is deliberately no status column: paid/unpaid is read live from the
// money request (ADR-0026). The user index also carries `created_at DESC` in
// the migration.
@Entity('bill_split_participants')
@Unique('UQ_bill_split_participants_bill_split_id_user_id', [
  'billSplitId',
  'userId',
])
@Index('IDX_bill_split_participants_user_id_created_at', [
  'userId',
  'createdAt',
])
export class BillSplitParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  billSplitId: string;

  @ManyToOne(() => BillSplit)
  @JoinColumn({ name: 'bill_split_id' })
  billSplit: BillSplit;

  @Column('uuid')
  userId: string;

  @Column('bigint', { transformer: bigintTransformer })
  amount: bigint;

  @Column('uuid', { unique: true })
  moneyRequestId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
