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
 * client in subscriber mode cannot issue normal commands. Both go through
 * createClient: `duplicate()` would drop the error listener, and an unhandled
 * ioredis 'error' event crashes the process.
 */
export function createAdapterClients(): { pubClient: Redis; subClient: Redis } {
  return { pubClient: createClient('adapter-pub'), subClient: createClient('adapter-sub') };
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  logger.debug('redis disconnected');
}
