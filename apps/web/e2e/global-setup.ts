import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clearRateLimits } from './redis';

/**
 * The suite signs up dozens of made-up @example.com accounts and reads their
 * emails out of Mailpit. With real email switched on (SMTP_HOST in .env) that
 * would send each one for real, and every test would wait for mail that never
 * reaches Mailpit. Stop before anything is sent.
 */
function assertMailpit(): void {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (!existsSync(path)) return;
  const host = /^\s*SMTP_HOST\s*=\s*(\S+)/m.exec(readFileSync(path, 'utf8'))?.[1];
  if (host) {
    throw new Error(
      `Real email is on (SMTP_HOST=${host} in .env). The end-to-end tests read ` +
        'email from Mailpit: comment SMTP_HOST out, restart the API, then run them.',
    );
  }
}

/**
 * Local runs start from a clean slate for rate limits only. Sessions,
 * presence and everything else are left alone. See e2e/redis.ts.
 */
export default async function globalSetup(): Promise<void> {
  assertMailpit();
  await clearRateLimits('rl:*');
}
