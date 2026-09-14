import { Redis } from 'ioredis';

/**
 * The suite signs up several accounts per run, from one IP. The API's
 * registration limit (10 per IP per hour) is working as intended when it
 * refuses the second run within the hour, so rather than loosen the limit,
 * local runs start from a clean slate: only rate-limit counters (rl:*) are
 * removed. Sessions, presence and everything else are left alone.
 *
 * Guarded to localhost so it can never touch a shared environment.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379';
  if (!/^redis:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\d+)?$/.test(url)) {
    throw new Error(`Refusing to clear rate limits on non-local Redis: ${url}`);
  }

  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'rl:*', 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}
