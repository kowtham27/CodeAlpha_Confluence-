import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { publicUserSchema, verifyEmailResponseSchema } from '@confluence/shared';
import { createApp } from '../../app.js';
import { memoryOutbox } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import {
  PASSWORD,
  WEB_ORIGIN,
  argon2Params,
  cookieHeader,
  errorOf,
  login,
  refresh,
  refreshCookieFrom,
  registerAndVerify,
  resetState,
  tokenFromLatestEmail,
} from '../../../test/helpers.js';

const app = createApp();

beforeEach(resetState);
afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});

describe('registration and email verification', () => {
  it('requires a verified email before sign-in', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'ada@example.com', password: PASSWORD, displayName: 'Ada' })
      .expect(202);

    const blocked = await request(app)
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(403);
    expect(errorOf(blocked).code).toBe('EMAIL_NOT_VERIFIED');

    const verified = await request(app)
      .post('/auth/verify-email')
      .send({ token: tokenFromLatestEmail('ada@example.com') })
      .expect(200);
    expect(verifyEmailResponseSchema.parse(verified.body).email).toBe('ada@example.com');

    const { auth } = await login(app);
    expect(auth.user.emailVerified).toBe(true);
  });

  it('does not reveal whether an email is already registered', async () => {
    await registerAndVerify(app);
    memoryOutbox.length = 0;

    const duplicate = await request(app)
      .post('/auth/register')
      .send({ email: 'ada@example.com', password: 'a different password', displayName: 'Mallory' })
      .expect(202);
    const fresh = await request(app)
      .post('/auth/register')
      .send({ email: 'grace@example.com', password: PASSWORD, displayName: 'Grace' })
      .expect(202);

    // Identical responses; the difference is only visible to the inbox owner.
    expect(duplicate.body).toEqual(fresh.body);
    expect(memoryOutbox.find((m) => m.to === 'ada@example.com')?.subject).toMatch(
      /tried to sign up/,
    );
    expect(await prisma.user.count({ where: { email: 'ada@example.com' } })).toBe(1);
  });

  it('normalises email case so ADA@ and ada@ are one account', async () => {
    await registerAndVerify(app, 'Ada@Example.COM');
    await login(app, 'ada@example.com');
  });

  it('accepts a verification link only once', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'ada@example.com', password: PASSWORD, displayName: 'Ada' })
      .expect(202);
    const token = tokenFromLatestEmail('ada@example.com');

    await request(app).post('/auth/verify-email').send({ token }).expect(200);
    const again = await request(app).post('/auth/verify-email').send({ token }).expect(400);
    expect(errorOf(again).code).toBe('INVALID_TOKEN');
  });

  it('invalidates older links when a new one is sent', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'ada@example.com', password: PASSWORD, displayName: 'Ada' })
      .expect(202);
    const first = tokenFromLatestEmail('ada@example.com');

    await request(app)
      .post('/auth/verify-email/resend')
      .send({ email: 'ada@example.com' })
      .expect(202);
    const second = tokenFromLatestEmail('ada@example.com');
    expect(second).not.toBe(first);

    await request(app).post('/auth/verify-email').send({ token: first }).expect(400);
    await request(app).post('/auth/verify-email').send({ token: second }).expect(200);
  });

  it('enforces the password length policy', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'ada@example.com', password: 'short', displayName: 'Ada' })
      .expect(422);
    expect(errorOf(res).details?.['password']).toBeDefined();
  });

  it('stores an argon2id hash, never the password', async () => {
    await registerAndVerify(app);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.com' } });
    expect(argon2Params(user.passwordHash)).toEqual({
      algorithm: 'argon2id',
      m: 65536,
      t: 3,
      p: 1,
    });
    expect(user.passwordHash).not.toContain(PASSWORD);
  });
});

describe('login', () => {
  beforeEach(() => registerAndVerify(app));

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const unknown = await request(app)
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401);
    const wrong = await request(app)
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'ada@example.com', password: 'not the password' })
      .expect(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('locks an email after 5 failures, even for the correct password', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ email: 'ada@example.com', password: `wrong guess ${i}` })
        .expect(401);
    }
    const locked = await request(app)
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(429);
    expect(errorOf(locked).code).toBe('RATE_LIMITED');
  });

  it('resets the failure count after a successful login', async () => {
    for (let i = 0; i < 4; i++) {
      await request(app)
        .post('/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ email: 'ada@example.com', password: `wrong ${i}` })
        .expect(401);
    }
    await login(app);
    await request(app)
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'ada@example.com', password: 'wrong again' })
      .expect(401);
  });

  it('rejects a cross-origin login attempt', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('sets the refresh cookie httpOnly, Secure, SameSite=Strict, scoped to /auth', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);
    const raw: unknown = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? (raw as string[]) : [])[0] ?? '';
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/auth/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('serves /auth/me with the access token', async () => {
    const { auth } = await login(app);
    const me = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(200);
    expect(publicUserSchema.parse(me.body).email).toBe('ada@example.com');

    await request(app).get('/auth/me').expect(401);
    await request(app).get('/auth/me').set('Authorization', 'Bearer not.a.jwt').expect(401);
  });
});

describe('refresh token rotation', () => {
  beforeEach(() => registerAndVerify(app));

  it('rotates: each refresh consumes the old token and issues a new one', async () => {
    const { refreshToken } = await login(app);

    const res = await refresh(app, refreshToken).expect(200);
    const next = refreshCookieFrom(res);
    expect(next).toBeTruthy();
    expect(next).not.toBe(refreshToken);

    // Only one token per session stays live.
    const live = await prisma.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(1);
  });

  it('treats an immediate replay as a benign race, not theft', async () => {
    const { refreshToken } = await login(app);
    const first = await refresh(app, refreshToken).expect(200);
    const next = refreshCookieFrom(first);
    if (!next) throw new Error('no rotated cookie');

    // Two tabs refreshing together: the loser is told to retry...
    const replay = await refresh(app, refreshToken).expect(401);
    expect(errorOf(replay).code).toBe('REFRESH_STALE');

    // ...and the session survives, because the winner's token still works.
    await refresh(app, next).expect(200);
  });

  it('detects reuse of a rotated token and revokes the whole session', async () => {
    const { auth, refreshToken: stolen } = await login(app);
    const rotated = await refresh(app, stolen).expect(200);
    const legitimate = refreshCookieFrom(rotated);
    if (!legitimate) throw new Error('no rotated cookie');

    // Move past the grace window, as a real attacker replay would be.
    await prisma.refreshToken.updateMany({
      where: { revokedReason: 'ROTATED' },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    const reuse = await refresh(app, stolen).expect(401);
    expect(errorOf(reuse).code).toBe('UNAUTHENTICATED');

    // Both parties are out: the legitimate token no longer refreshes...
    await refresh(app, legitimate).expect(401);
    // ...and access tokens already issued for the session stop working now.
    await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(401);

    // Audit writes are fire-and-forget, so wait for the row to land.
    await vi.waitFor(async () => {
      const logged = await prisma.auditLog.findFirst({
        where: { action: 'auth.refresh.reuse_detected' },
      });
      expect(logged).not.toBeNull();
    });
  });

  it('rejects a refresh with no cookie or an unknown token', async () => {
    await request(app).post('/auth/refresh').set('Origin', WEB_ORIGIN).expect(401);
    await refresh(app, 'A'.repeat(43)).expect(401);
  });

  it('never issues a token past the 30-day family lifetime', async () => {
    const { refreshToken } = await login(app);
    const familyEnd = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.refreshToken.updateMany({ data: { familyExpiresAt: familyEnd } });

    await refresh(app, refreshToken).expect(200);
    const newest = await prisma.refreshToken.findFirstOrThrow({ where: { revokedAt: null } });
    expect(newest.expiresAt.getTime()).toBeLessThanOrEqual(familyEnd.getTime());
  });
});

describe('logout', () => {
  beforeEach(() => registerAndVerify(app));

  it('ends this session only', async () => {
    const laptop = await login(app);
    const phone = await login(app);

    const res = await request(app)
      .post('/auth/logout')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', cookieHeader(laptop.refreshToken))
      .expect(204);
    expect(String(res.headers['set-cookie'])).toMatch(/confluence_rt=;/);

    await refresh(app, laptop.refreshToken).expect(401);
    await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${laptop.auth.accessToken}`)
      .expect(401);

    await refresh(app, phone.refreshToken).expect(200);
  });

  it('logs out everywhere', async () => {
    const laptop = await login(app);
    const phone = await login(app);

    await request(app)
      .post('/auth/logout-all')
      .set('Origin', WEB_ORIGIN)
      .set('Authorization', `Bearer ${laptop.auth.accessToken}`)
      .expect(204);

    for (const session of [laptop, phone]) {
      await refresh(app, session.refreshToken).expect(401);
      await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${session.auth.accessToken}`)
        .expect(401);
    }

    // A fresh login afterwards is unaffected.
    await login(app);
  });

  it('is idempotent without a session', async () => {
    await request(app).post('/auth/logout').set('Origin', WEB_ORIGIN).expect(204);
  });
});
