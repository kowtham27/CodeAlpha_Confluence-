import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { generateOpaqueToken, hashToken, signAccessToken, verifyAccessToken } from './tokens.js';

const claims = { userId: 'user_1', sessionId: 'session_1' };
const key = new TextEncoder().encode(process.env['JWT_ACCESS_SECRET']);

describe('access tokens', () => {
  it('round-trips its claims', async () => {
    const result = await verifyAccessToken(await signAccessToken(claims));
    expect(result).toEqual({ ok: true, claims });
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = (await signAccessToken(claims)).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', sid: 'x' })).toString('base64url');
    expect(await verifyAccessToken(`${header}.${forged}.${signature}`)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reports expiry distinctly, so the client knows to refresh', async () => {
    const expired = await new SignJWT({ sid: 's' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer('confluence-api')
      .setAudience('confluence-web')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    expect(await verifyAccessToken(expired)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects the "none" algorithm', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'u', sid: 's', iss: 'confluence-api', aud: 'confluence-web' }),
    ).toString('base64url');
    expect((await verifyAccessToken(`${header}.${body}.`)).ok).toBe(false);
  });

  it('rejects a token for a different audience', async () => {
    const other = await new SignJWT({ sid: 's' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer('confluence-api')
      .setAudience('some-other-app')
      .setExpirationTime('5m')
      .sign(key);
    expect((await verifyAccessToken(other)).ok).toBe(false);
  });
});

describe('opaque tokens', () => {
  it('are 256-bit base64url strings', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(token);
  });

  it('hash deterministically and never equal the raw token', () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });
});
