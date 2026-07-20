import { createHash } from 'crypto';
import { DefaultNamingStrategy, NamingStrategyInterface, Table } from 'typeorm';

// Postgres identifier limit — names longer than this get silently truncated
// by Postgres itself, which is how you get two different constraints that
// collide without any error. Anything we build that could exceed it gets a
// hash suffix instead of a silent truncation.
const MAX_IDENTIFIER_LENGTH = 63;

function toSnakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

function buildIdentifier(parts: string[]): string {
  const name = parts.filter(Boolean).join('_');
  if (name.length <= MAX_IDENTIFIER_LENGTH) {
    return name;
  }
  const hash = shortHash(name);
  return `${name.slice(0, MAX_IDENTIFIER_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * Every table/column/constraint name Cliqpay's schema produces is snake_case
 * and, for constraints, human-readable rather than a hash — see
 * docs/architecture.md §5's own note on widening `CHECK` constraints via
 * plain `ALTER TABLE ... DROP CONSTRAINT <name>`: that only stays easy if
 * the name in the migration file is legible, not `CHK_3f9a2b7c...`.
 */
export class CliqpayNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  tableName(targetName: string, userSpecifiedName: string | undefined): string {
    return userSpecifiedName ?? toSnakeCase(targetName);
  }

  columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    const base = customName ?? toSnakeCase(propertyName);
    if (embeddedPrefixes.length === 0) {
      return base;
    }
    return [...embeddedPrefixes.map(toSnakeCase), base].join('_');
  }

  relationName(propertyName: string): string {
    return toSnakeCase(propertyName);
  }

  indexName(tableOrName: Table | string, columnNames: string[]): string {
    return buildIdentifier([
      'IDX',
      this.getTableName(tableOrName),
      ...[...columnNames].sort(),
    ]);
  }
}
