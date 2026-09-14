import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const TEST_DB = 'confluence_test';
const ADMIN_URL = 'postgresql://confluence:confluence_dev_pw@localhost:5432/postgres';
const TEST_URL = `postgresql://confluence:confluence_dev_pw@localhost:5432/${TEST_DB}?schema=public`;

/**
 * Creates the test database on first run and brings it to the latest
 * migration. `migrate deploy` applies pending migrations only; it never
 * resets, so it is safe to run on every test invocation.
 */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error('Integration tests need Postgres and Redis. Run `pnpm infra:up` first.', {
      cause: error,
    });
  }
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  execSync('pnpm exec prisma migrate deploy', {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: TEST_URL },
    stdio: 'pipe',
  });
}
