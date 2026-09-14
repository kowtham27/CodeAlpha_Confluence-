import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Each rotation extends the session by this much... */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** ...up to this absolute cap from the original login. */
export const REFRESH_FAMILY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Short on purpose: a reset link hands over the account, a verify link does not. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const ISSUER = 'confluence-api';
const AUDIENCE = 'confluence-web';
const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessClaims {
  userId: string;
  /** Refresh-token family id; lets a logout revoke outstanding access tokens. */
  sessionId: string;
}

export type AccessVerification =
  { ok: true; claims: AccessClaims } | { ok: false; reason: 'expired' | 'invalid' };

export function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .setJti(randomUUID())
    .sign(accessKey);
}

export async function verifyAccessToken(token: string): Promise<AccessVerification> {
  try {
    const { payload } = await jwtVerify(token, accessKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Pinned: never let the token header choose the algorithm.
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload['sid'] !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, claims: { userId: payload.sub, sessionId: payload['sid'] } };
  } catch (error) {
    return { ok: false, reason: error instanceof errors.JWTExpired ? 'expired' : 'invalid' };
  }
}

/**
 * Refresh and email-verification tokens are opaque random strings, not JWTs:
 * they are only ever checked against the database, so a self-describing
 * signed format would add attack surface and nothing else.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Tokens are stored as keyed hashes. A database dump alone yields nothing
 * usable: the raw token is never persisted, and the key lives in env.
 */
export function hashToken(token: string): string {
  return createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex');
}
