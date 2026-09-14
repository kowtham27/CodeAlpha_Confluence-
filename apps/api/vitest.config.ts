import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against real Postgres and Redis (pnpm infra:up), but
 * never the dev data: a separate database, and Redis logical DB 15, which the
 * suite flushes between tests.
 */
const INTEGRATION_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    'postgresql://confluence:confluence_dev_pw@localhost:5432/confluence_test?schema=public',
  REDIS_URL: 'redis://localhost:6379/15',
  MAIL_TRANSPORT: 'memory',
};

export default defineConfig({
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
          env: { LOG_LEVEL: 'silent', MAIL_TRANSPORT: 'memory' },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          env: INTEGRATION_ENV,
          globalSetup: ['./test/global-setup.ts'],
          // One shared database: files must not truncate each other's rows.
          fileParallelism: false,
          // argon2 at 64MB is ~300ms per hash; flows hash several times.
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
