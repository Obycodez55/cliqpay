import { randomUUID } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import {
  AccountRestriction,
  RestrictionReason,
  RestrictionScope,
} from '../../../src/modules/users/entities/account-restriction.entity';

export async function addTestRestriction(
  dataSource: Pick<DataSource, 'getRepository'>,
  userId: string,
  options: { reason?: RestrictionReason; scope?: RestrictionScope } = {},
): Promise<string> {
  const sourceId = randomUUID();
  await dataSource.getRepository(AccountRestriction).insert({
    userId,
    reason: options.reason ?? 'fraud',
    scope: options.scope ?? 'outbound',
    sourceId,
  });
  return sourceId;
}

export function hasOpenRestriction(
  dataSource: DataSource,
  userId: string,
): Promise<boolean> {
  return dataSource
    .getRepository(AccountRestriction)
    .existsBy({ userId, liftedAt: IsNull() });
}
