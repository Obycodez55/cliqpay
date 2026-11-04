import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

declare global {
  var __CLIQPAY_TEST_PG__: StartedPostgreSqlContainer | undefined;
}
