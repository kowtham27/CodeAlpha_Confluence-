import { randomUUID } from 'node:crypto';
import type { RevokeReason } from '../../generated/prisma/client.js';
import { authEvents } from '../../lib/auth-events.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { AUDIT_ACTIONS, audit, type RequestContext } from '../../lib/audit.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_FAMILY_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  generateOpaqueToken,
  hashToken,
  signAccessToken,
} from './tokens.js';

/**
 * A rotated token presented again within this window is treated as a benign
 * race (two tabs refreshing at once), not theft. It is still rejected: the
 * grace period only spares the family from revocation. It grants nothing.
 */
const ROTATION_GRACE_MS = 10_000;

export interface IssuedSession {
  userId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export type RotationResult =
  | { ok: true; session: IssuedSession }
  | { ok: false; reason: 'invalid' | 'expired' | 'stale' | 'reuse' };

const revokedSessionKey = (sessionId: string): string => `auth:revoked-session:${sessionId}`;

export async function createSession(
  userId: string,
  context: RequestContext,
): Promise<IssuedSession> {
  const now = Date.now();
  const sessionId = randomUUID();
  const refreshToken = generateOpaqueToken();
  const familyExpiresAt = new Date(now + REFRESH_FAMILY_TTL_MS);
  const refreshExpiresAt = new Date(now + REFRESH_TOKEN_TTL_MS);

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      familyId: sessionId,
      expiresAt: refreshExpiresAt,
      familyExpiresAt,
      userAgent: context.userAgent,
      ip: context.ip,
    },
  });

  // Housekeeping: expired rows can no longer be presented, so they no longer
  // serve reuse detection either. Unexpired revoked rows are kept on purpose.
  prisma.refreshToken
    .deleteMany({ where: { userId, expiresAt: { lt: new Date(now) } } })
    .catch((error: unknown) => logger.warn({ err: error }, 'refresh token cleanup failed'));

  return {
    userId,
    sessionId,
    accessToken: await signAccessToken({ userId, sessionId }),
    refreshToken,
    refreshExpiresAt,
  };
}

/**
 * Refresh token rotation with reuse detection.
 *
 * Every refresh consumes the presented token and issues a new one in the same
 * family. Tokens are single-use, so seeing a consumed token again means two
 * parties hold it: the legitimate client and whoever stole it. We cannot tell
 * which is which, so the whole family is revoked and both must log in again.
 * The attacker's window shrinks to "until the victim next refreshes".
 */
export async function rotateSession(
  presentedToken: string,
  context: RequestContext,
): Promise<RotationResult> {
  const now = new Date();
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(presentedToken) },
  });

  if (!record) return { ok: false, reason: 'invalid' };

  if (record.revokedAt) {
    if (record.revokedReason !== 'ROTATED') return { ok: false, reason: 'invalid' };

    if (now.getTime() - record.revokedAt.getTime() < ROTATION_GRACE_MS) {
      return { ok: false, reason: 'stale' };
    }

    await revokeSessions(record.userId, [record.familyId], 'REUSE_DETECTED');
    audit(AUDIT_ACTIONS.REFRESH_REUSE_DETECTED, context, {
      userId: record.userId,
      metadata: { sessionId: record.familyId },
    });
    logger.warn(
      { userId: record.userId, sessionId: record.familyId },
      'refresh token reuse detected; session family revoked',
    );
    return { ok: false, reason: 'reuse' };
  }

  if (record.expiresAt <= now) return { ok: false, reason: 'expired' };

  const refreshToken = generateOpaqueToken();
  const refreshExpiresAt = new Date(
    Math.min(now.getTime() + REFRESH_TOKEN_TTL_MS, record.familyExpiresAt.getTime()),
  );

  const rotated = await prisma.$transaction(async (tx) => {
    // Conditional on revokedAt still being null: if a concurrent request
    // rotated this token first, count is 0 and this request loses the race.
    const consumed = await tx.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'ROTATED' },
    });
    if (consumed.count === 0) return false;

    await tx.refreshToken.create({
      data: {
        userId: record.userId,
        tokenHash: hashToken(refreshToken),
        familyId: record.familyId,
        expiresAt: refreshExpiresAt,
        familyExpiresAt: record.familyExpiresAt,
        userAgent: context.userAgent,
        ip: context.ip,
      },
    });
    return true;
  });

  if (!rotated) return { ok: false, reason: 'stale' };

  return {
    ok: true,
    session: {
      userId: record.userId,
      sessionId: record.familyId,
      accessToken: await signAccessToken({ userId: record.userId, sessionId: record.familyId }),
      refreshToken,
      refreshExpiresAt,
    },
  };
}

/** Looks up which session a refresh token belongs to, for logout. */
export async function findSessionByToken(
  presentedToken: string,
): Promise<{ userId: string; sessionId: string } | null> {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(presentedToken) },
    select: { userId: true, familyId: true },
  });
  return record ? { userId: record.userId, sessionId: record.familyId } : null;
}

/**
 * Revokes whole sessions: every refresh token in each family, plus a Redis
 * marker so access tokens already issued for those sessions stop working
 * immediately instead of living out their 15 minutes.
 */
export async function revokeSessions(
  userId: string,
  sessionIds: string[],
  reason: RevokeReason,
): Promise<void> {
  if (sessionIds.length === 0) return;

  await prisma.refreshToken.updateMany({
    where: { userId, familyId: { in: sessionIds }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });

  // The marker only has to outlive the longest-lived access token.
  const pipeline = redis.pipeline();
  for (const id of sessionIds) {
    pipeline.set(revokedSessionKey(id), reason, 'EX', ACCESS_TOKEN_TTL_SECONDS);
  }
  await pipeline.exec();

  authEvents.emit('sessions-revoked', { userId, sessionIds });
}

/** "Log out everywhere": every active session the user has. */
export async function revokeAllSessions(userId: string, reason: RevokeReason): Promise<number> {
  const active = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null },
    select: { familyId: true },
    distinct: ['familyId'],
  });
  const sessionIds = active.map((row) => row.familyId);
  await revokeSessions(userId, sessionIds, reason);
  return sessionIds.length;
}

/**
 * Checked on every authenticated request. Fails open: if Redis is down, a
 * revoked session keeps working until its access token expires (15 minutes
 * at most) rather than every user being locked out. See SECURITY.md.
 */
export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  try {
    return (await redis.exists(revokedSessionKey(sessionId))) === 1;
  } catch (error) {
    logger.error({ err: error }, 'session revocation check failed; failing open');
    return false;
  }
}
