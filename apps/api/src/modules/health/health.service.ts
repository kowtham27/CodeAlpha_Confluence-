import type { DependencyStatus, HealthResponse } from '@confluence/shared';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { probeStorage } from '../../lib/storage.js';

const PROBE_TIMEOUT_MS = 2_000;

/**
 * A health check that can hang is worse than no health check: orchestrators
 * read a timeout as "still starting" and keep routing traffic. Every probe is
 * bounded.
 */
async function withTimeout<T>(probe: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Prisma wraps driver failures in a multi-line message whose first lines are
 * often blank, which reaches the health endpoint as an empty string. Flatten
 * the whitespace and fall back through cause and name so the response always
 * says something actionable.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const flattened = error.message.replace(/\s+/g, ' ').trim();
  const cause = error.cause instanceof Error ? error.cause.message.trim() : '';
  if (flattened && cause) return `${flattened} (${cause})`;
  return flattened || cause || error.name;
}

async function probe(fn: () => Promise<unknown>): Promise<DependencyStatus> {
  const startedAt = performance.now();
  try {
    await withTimeout(fn(), PROBE_TIMEOUT_MS);
    return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - startedAt),
      error: describeError(error),
    };
  }
}

export async function getHealth(version: string): Promise<HealthResponse> {
  const [postgres, redisStatus, storage] = await Promise.all([
    probe(() => prisma.$queryRaw`SELECT 1`),
    probe(() => redis.ping()),
    probe(() => probeStorage()),
  ]);

  const allUp = postgres.status === 'up' && redisStatus.status === 'up';

  return {
    status: allUp ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    version,
    dependencies: { postgres, redis: redisStatus, storage },
  };
}
