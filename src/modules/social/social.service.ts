import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  PostStateResponseDto,
  toPostStateResponse,
} from './dto/post-state-response.dto';
import {
  POST_VISIBILITIES,
  PostVisibility,
  TransactionPost,
} from './entities/transaction-post.entity';
import { PostNotFoundException } from './internal/errors';

export { POST_VISIBILITIES };
export type { PostVisibility };

export interface RecordTransferPostParams {
  transactionId: string;
  senderUserId: string;
  recipientUserId: string;
  note: string | null;
  visibility: PostVisibility;
}

@Injectable()
export class SocialService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async recordTransferPost(
    manager: EntityManager,
    params: RecordTransferPostParams,
  ): Promise<void> {
    const repo = manager.getRepository(TransactionPost);
    await repo.insert(
      repo.create({
        transactionId: params.transactionId,
        senderUserId: params.senderUserId,
        recipientUserId: params.recipientUserId,
        note: params.note,
        visibility: params.visibility,
        requestedVisibility: params.visibility,
        hiddenByRecipient: false,
      }),
    );
  }

  async getRequestedVisibility(
    transactionId: string,
  ): Promise<PostVisibility | null> {
    const post = await this.dataSource.getRepository(TransactionPost).findOne({
      where: { transactionId },
      select: { requestedVisibility: true },
    });
    return post?.requestedVisibility ?? null;
  }

  async setVisibility(
    senderId: string,
    transactionId: string,
    visibility: PostVisibility,
  ): Promise<PostStateResponseDto> {
    const repo = this.dataSource.getRepository(TransactionPost);
    const post = await repo.findOneBy({
      transactionId,
      senderUserId: senderId,
    });
    if (!post) {
      throw new PostNotFoundException();
    }
    post.visibility = visibility;
    return toPostStateResponse(await repo.save(post));
  }

  async setHiddenByRecipient(
    recipientId: string,
    transactionId: string,
    hidden: boolean,
  ): Promise<PostStateResponseDto> {
    const repo = this.dataSource.getRepository(TransactionPost);
    const post = await repo.findOneBy({
      transactionId,
      recipientUserId: recipientId,
    });
    if (!post) {
      throw new PostNotFoundException();
    }
    post.hiddenByRecipient = hidden;
    return toPostStateResponse(await repo.save(post));
  }
}
