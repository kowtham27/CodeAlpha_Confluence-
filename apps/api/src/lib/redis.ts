import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

function createClient(label: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });

  client.on('error', (error: Error) => {
    // ioredis reconnects on its own; log without crashing the process.
    logger.error({ err: error, client: label }, 'redis connection error');
  });
  client.on('ready', () => logger.debug({ client: label }, 'redis ready'));

  return client;
}

/** General-purpose client: presence, rate limits, locks, whiteboard sequence. */
export const redis = createClient('main');

/**
 * The Socket.IO Redis adapter needs its own pub and sub connections, because a
 * client in subscriber mode cannot issue normal commands. Created in Phase 2
 * via `redis.duplicate()`.
 */
export function createAdapterClients(): { pubClient: Redis; subClient: Redis } {
  const pubClient = createClient('adapter-pub');
  return { pubClient, subClient: pubClient.duplicate() };
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  logger.debug('redis disconnected');
}
