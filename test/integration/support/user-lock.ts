import { DataSource } from 'typeorm';

// Holds the same per-user advisory lock the KYC checks take, in its own
// transaction. A call that must be serialized on that lock cannot settle until
// release() is called; one that doesn't take it finishes straight away.
export async function holdUserLock(
  dataSource: DataSource,
  userId: string,
): Promise<{ release: () => Promise<void> }> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  await queryRunner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    userId,
  ]);
  return {
    release: async () => {
      await queryRunner.commitTransaction();
      await queryRunner.release();
    },
  };
}

export function trackSettled<T>(thenable: PromiseLike<T>): {
  promise: Promise<T>;
  isSettled: () => boolean;
} {
  let settled = false;
  const tracked = Promise.resolve(thenable).finally(() => {
    settled = true;
  });
  return { promise: tracked, isSettled: () => settled };
}

export const LOCK_WAIT_MS = 500;
export const waitBriefly = () =>
  new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
