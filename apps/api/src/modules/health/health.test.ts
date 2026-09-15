import { describe, expect, it, vi, beforeEach } from 'vitest';
import { healthResponseSchema } from '@confluence/shared';

// Typed explicitly: a bare vi.fn() returns `any`, which quietly disables the
// no-unsafe-* rules for everything downstream of it.
const queryRaw = vi.fn<() => Promise<unknown>>();
const ping = vi.fn<() => Promise<string>>();

vi.mock('../../lib/prisma.js', () => ({ prisma: { $queryRaw: () => queryRaw() } }));
vi.mock('../../lib/redis.js', () => ({ redis: { ping: () => ping() } }));
vi.mock('../../lib/storage.js', () => ({ probeStorage: () => Promise.resolve() }));

const { getHealth } = await import('./health.service.js');

describe('getHealth', () => {
  beforeEach(() => {
    queryRaw.mockReset();
    ping.mockReset();
  });

  it('reports ok when both dependencies respond', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    ping.mockResolvedValue('PONG');

    const health = await getHealth('0.1.0');

    expect(health.status).toBe('ok');
    expect(health.dependencies.postgres.status).toBe('up');
    expect(health.dependencies.redis.status).toBe('up');
    // The response must satisfy the shared contract, not just look right.
    expect(() => healthResponseSchema.parse(health)).not.toThrow();
  });

  it('reports degraded and names the failing dependency', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));
    ping.mockResolvedValue('PONG');

    const health = await getHealth('0.1.0');

    expect(health.status).toBe('degraded');
    expect(health.dependencies.postgres.status).toBe('down');
    expect(health.dependencies.postgres.error).toContain('connection refused');
    expect(health.dependencies.redis.status).toBe('up');
  });

  it('does not let one slow dependency mask the other', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    ping.mockRejectedValue(new Error('READONLY'));

    const health = await getHealth('0.1.0');

    expect(health.dependencies.postgres.status).toBe('up');
    expect(health.dependencies.redis.status).toBe('down');
    expect(health.status).toBe('degraded');
  });
});
