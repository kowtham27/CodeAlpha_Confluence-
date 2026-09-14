import { clearRateLimits } from './redis';

/**
 * Local runs start from a clean slate for rate limits only. Sessions,
 * presence and everything else are left alone. See e2e/redis.ts.
 */
export default async function globalSetup(): Promise<void> {
  await clearRateLimits('rl:*');
}
