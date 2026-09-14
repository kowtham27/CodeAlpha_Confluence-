import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env, isProduction } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Prisma 7 connects through a driver adapter rather than a schema-level url.
 * The pool is owned here so shutdown can drain it deterministically.
 */
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: isProduction ? 20 : 5,
});

export const prisma = new PrismaClient({
  adapter,
  log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  logger.debug('prisma disconnected');
}
