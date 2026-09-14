import { Redis } from 'ioredis';

/**
 * Local-only access to the dev Redis, for resetting rate-limit counters the
 * suite legitimately exceeds (it signs up more accounts per run than the
 * 10-per-hour registration limit allows). Nothing else is ever touched.
 */
const url = process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379';

function assertLocal(): void {
  if (!/^redis:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\d+)?$/.test(url)) {
    throw new Error(`Refusing to clear rate limits on non-local Redis: ${url}`);
  }
}

/** Deletes rate-limit keys matching `pattern` (always under the rl: prefix). */
export async function clearRateLimits(pattern = 'rl:*'): Promise<void> {
  assertLocal();
  if (!pattern.startsWith('rl:')) throw new Error('Only rate-limit keys may be cleared');
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}
