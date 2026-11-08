import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

export interface TestPostOptions {
  sender: string;
  recipient: string;
  visibility?: 'public' | 'private';
  hidden?: boolean;
  note?: string | null;
  createdAt?: string;
}

export async function insertTransferPost(
  dataSource: DataSource,
  options: TestPostOptions,
): Promise<string> {
  const postId = randomUUID();
  const visibility = options.visibility ?? 'public';
  const hidden = options.hidden ?? false;
  const isPublic = visibility === 'public' && !hidden;
  await dataSource.query(
    `WITH post AS (
      INSERT INTO posts
        (id, kind, author_user_id, note, visibility, requested_visibility, is_public, created_at, published_at)
      VALUES ($1, 'transfer', $2, $4, $5, $5, $6, COALESCE($7::timestamptz, clock_timestamp()), COALESCE($7::timestamptz, clock_timestamp()))
      RETURNING id, created_at
    )
    INSERT INTO post_participants (post_id, user_id, role, hidden, post_created_at, post_is_public)
    SELECT post.id, m.user_id, m.role, m.hidden, post.created_at, $6
    FROM post, (VALUES ($2::uuid, 'author', false), ($3::uuid, 'counterparty', $8::boolean))
      AS m(user_id, role, hidden)`,
    [
      postId,
      options.sender,
      options.recipient,
      options.note === undefined ? 'lunch' : options.note,
      visibility,
      isPublic,
      options.createdAt ?? null,
      hidden,
    ],
  );
  return postId;
}
