import { EntityManager } from 'typeorm';
import { User } from '../../../src/modules/users/entities/user.entity';

// A seeded account stands in for one that reached Tier 1 long ago; without
// this the 24-hour new-account cap would apply to every seeded user.
export async function establishAccount(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  await manager
    .getRepository(User)
    .update(
      { id: userId },
      { tier1ReachedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    );
}
