import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type { Result } from 'ioredis';
import { ERROR_STATUS, type AppError } from '@confluence/shared';
import { logger } from './logger.js';
import { redis } from './redis.js';

/**
 * Sliding-window limiter on a Redis sorted set: one member per hit, scored by
 * timestamp. Unlike fixed windows it has no boundary burst (a client cannot
 * spend the full budget at 11:59:59 and again at 12:00:00). The Lua script
 * makes check-and-record atomic, so concurrent requests cannot both squeeze
 * through the last slot, and Redis-backing makes the limit hold across API
 * instances, which an in-memory counter cannot.
 */
const SLIDING_WINDOW_LUA = [
  'local key = KEYS[1]',
  'local now = tonumber(ARGV[1])',
  'local window = tonumber(ARGV[2])',
  'local limit = tonumber(ARGV[3])',
  'local member = ARGV[4]',
  'local consume = ARGV[5]',
  "redis.call('ZREMRANGEBYSCORE', key, 0, now - window)",
  "local count = redis.call('ZCARD', key)",
  'if count >= limit then',
  "  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')",
  '  return {0, count, tonumber(oldest[2])}',
  'end',
  "if consume == '1' then",
  "  redis.call('ZADD', key, now, member)",
  "  redis.call('PEXPIRE', key, window)",
  '  count = count + 1',
  'end',
  'return {1, count, 0}',
].join('\n');

redis.defineCommand('slidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });

declare module 'ioredis' {
  interface RedisCommander<Context> {
    slidingWindow(
      key: string,
      now: number,
      windowMs: number,
      limit: number,
      member: string,
      consume: '0' | '1',
    ): Result<[number, number, number], Context>;
  }
}

export interface RateLimitRule {
  name: string;
  limit: number;
  windowMs: number;
  /**
   * What to do when Redis is unreachable. 'open' favours availability (the
   * global limiter); 'closed' favours safety (login brute-force protection).
   */
  failMode: 'open' | 'closed';
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export const RATE_LIMITS = {
  /** Spec: 100 requests per minute per IP. */
  globalIp: { name: 'global-ip', limit: 100, windowMs: 60_000, failMode: 'open' },
  /** Spec: 5 login attempts per email per 15 minutes. Counts failures only. */
  loginFailures: { name: 'login-fail', limit: 5, windowMs: 15 * 60_000, failMode: 'closed' },
  register: { name: 'register-ip', limit: 10, windowMs: 60 * 60_000, failMode: 'closed' },
  resendVerification: {
    name: 'resend-email',
    limit: 3,
    windowMs: 60 * 60_000,
    failMode: 'closed',
  },
  verifyEmail: { name: 'verify-ip', limit: 20, windowMs: 60 * 60_000, failMode: 'closed' },
} as const satisfies Record<string, RateLimitRule>;

export class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super('rate limiter unavailable', { cause });
    this.name = 'RateLimiterUnavailableError';
  }
}

/** Subjects are often emails; hashing keeps raw PII out of Redis keys. */
function keyFor(rule: RateLimitRule, subject: string): string {
  const digest = createHash('sha256').update(subject.toLowerCase()).digest('base64url');
  return `rl:${rule.name}:${digest}`;
}

async function run(
  rule: RateLimitRule,
  subject: string,
  shouldConsume: boolean,
): Promise<RateLimitResult> {
  const now = Date.now();
  const member = `${now}-${randomBytes(6).toString('hex')}`;
  try {
    const [allowed, count, oldest] = await redis.slidingWindow(
      keyFor(rule, subject),
      now,
      rule.windowMs,
      rule.limit,
      member,
      shouldConsume ? '1' : '0',
    );
    return {
      allowed: allowed === 1,
      remaining: Math.max(0, rule.limit - count),
      retryAfterSeconds:
        allowed === 1 ? 0 : Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)),
    };
  } catch (error) {
    logger.error({ err: error, rule: rule.name }, 'rate limiter unavailable');
    if (rule.failMode === 'open') {
      return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
    }
    throw new RateLimiterUnavailableError(error);
  }
}

/** Records a hit and reports whether it was within the limit. */
export const consume = (rule: RateLimitRule, subject: string): Promise<RateLimitResult> =>
  run(rule, subject, true);

/** Reports the current state without recording anything. */
export const peek = (rule: RateLimitRule, subject: string): Promise<RateLimitResult> =>
  run(rule, subject, false);

export async function reset(rule: RateLimitRule, subject: string): Promise<void> {
  await redis.del(keyFor(rule, subject)).catch((error: unknown) => {
    logger.warn({ err: error, rule: rule.name }, 'rate limit reset failed');
  });
}

export function sendRateLimited(res: Response, rule: RateLimitRule, result: RateLimitResult): void {
  const error: AppError = { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' };
  res
    .status(ERROR_STATUS.RATE_LIMITED)
    .set('Retry-After', String(result.retryAfterSeconds))
    .set('RateLimit-Limit', String(rule.limit))
    .set('RateLimit-Remaining', '0')
    .json({ error });
}

/** Middleware form, keyed by client IP. */
export function limitByIp(rule: RateLimitRule): RequestHandler {
  return (req, res, next) => {
    consume(rule, req.ip ?? 'unknown')
      .then((result) => {
        res.set('RateLimit-Limit', String(rule.limit));
        res.set('RateLimit-Remaining', String(result.remaining));
        if (!result.allowed) {
          sendRateLimited(res, rule, result);
          return;
        }
        next();
      })
      .catch(next);
  };
}
