// Importing env first makes configuration failures the very first thing that
// can go wrong, before any connection is attempted.
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { disconnectRedis } from './lib/redis.js';
import { createAppServer } from './server.js';

const { httpServer, io } = createAppServer();

httpServer.listen(env.API_PORT, env.API_HOST, () => {
  logger.info(
    { port: env.API_PORT, host: env.API_HOST, env: env.NODE_ENV },
    'confluence api listening',
  );
});

let shuttingDown = false;

/**
 * Drain in dependency order: stop accepting connections, close sockets, then
 * release Postgres and Redis. The timer is a backstop so a wedged connection
 * cannot block the container forever.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await io.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await Promise.all([disconnectPrisma(), disconnectRedis()]);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// Spec section 5: no unhandled rejections. Both handlers log and exit rather
// than leaving the process in an unknown state.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException');
});
