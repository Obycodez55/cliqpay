import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';

export const TEMPLATE_DATABASE = 'cliqpay_template';
export const ADMIN_URL_ENV = 'CLIQPAY_TEST_PG_ADMIN_URL';

function adminUrl(): string {
  const url = process.env[ADMIN_URL_ENV];
  if (!url) {
    throw new Error(
      `${ADMIN_URL_ENV} is not set: integration specs must run through test/jest-integration.json so globalSetup starts the shared Postgres`,
    );
  }
  return url;
}

export function databaseUrl(name: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

export async function withAdminConnection<T>(
  fn: (admin: DataSource) => Promise<T>,
): Promise<T> {
  const admin = new DataSource({ type: 'postgres', url: adminUrl() });
  await admin.initialize();
  try {
    return await fn(admin);
  } finally {
    await admin.destroy();
  }
}

export interface TestDatabase {
  name: string;
  url: string;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `spec_${randomBytes(6).toString('hex')}`;
  await withAdminConnection((admin) =>
    admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`),
  );
  return { name, url: databaseUrl(name) };
}

export async function dropTestDatabase(
  db: TestDatabase | undefined,
): Promise<void> {
  if (!db) return;
  await withAdminConnection((admin) =>
    admin.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`),
  );
}
