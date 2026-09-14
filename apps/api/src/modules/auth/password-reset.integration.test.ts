import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authResponseSchema, resetPasswordResponseSchema } from '@confluence/shared';
import { createApp } from '../../app.js';
import { memoryOutbox } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import {
  PASSWORD,
  WEB_ORIGIN,
  errorOf,
  login,
  refresh,
  registerAndVerify,
  resetState,
  tokenFromLatestEmail,
} from '../../../test/helpers.js';

const app = createApp();
const NEW_PASSWORD = 'an entirely new passphrase';

const forgot = (email: string) => request(app).post('/auth/password/forgot').send({ email });

const resetWith = (token: string, password = NEW_PASSWORD) =>
  request(app).post('/auth/password/reset').send({ token, password });

const resetToken = (email: string) => tokenFromLatestEmail(email, 'reset-password');

const signIn = (email: string, password: string) =>
  request(app).post('/auth/login').set('Origin', WEB_ORIGIN).send({ email, password });

beforeEach(async () => {
  await resetState();
  await registerAndVerify(app);
});

afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});

describe('password reset', () => {
  it('answers identically whether or not the account exists', async () => {
    const known = await forgot('ada@example.com').expect(202);
    const unknown = await forgot('nobody@example.com').expect(202);
    expect(known.body).toEqual(unknown.body);

    expect(memoryOutbox.some((m) => m.to === 'nobody@example.com')).toBe(false);
    expect(resetToken('ada@example.com')).toMatch(/^[\w-]{43}$/);
  });

  it('replaces the password: the old one stops working, the new one works', async () => {
    await forgot('ada@example.com').expect(202);
    const res = await resetWith(resetToken('ada@example.com')).expect(200);
    expect(resetPasswordResponseSchema.parse(res.body).email).toBe('ada@example.com');

    await signIn('ada@example.com', PASSWORD).expect(401);
    await signIn('ada@example.com', NEW_PASSWORD).expect(200);
  });

  it('signs out every existing session', async () => {
    const laptop = await login(app);
    const phone = await login(app);

    await forgot('ada@example.com').expect(202);
    await resetWith(resetToken('ada@example.com')).expect(200);

    for (const session of [laptop, phone]) {
      await refresh(app, session.refreshToken).expect(401);
      await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${session.auth.accessToken}`)
        .expect(401);
    }
    const revoked = await prisma.refreshToken.count({
      where: { revokedReason: 'PASSWORD_RESET' },
    });
    expect(revoked).toBe(2);
  });

  it('tells the owner their password changed', async () => {
    await forgot('ada@example.com').expect(202);
    await resetWith(resetToken('ada@example.com')).expect(200);
    expect(memoryOutbox.at(-1)?.subject).toBe('Your Confluence password was changed');
  });

  it('accepts a link only once, and only the newest one', async () => {
    await forgot('ada@example.com').expect(202);
    const first = resetToken('ada@example.com');
    await forgot('ada@example.com').expect(202);
    const second = resetToken('ada@example.com');

    expect(errorOf(await resetWith(first).expect(400)).code).toBe('INVALID_TOKEN');
    await resetWith(second).expect(200);
    expect(errorOf(await resetWith(second).expect(400)).code).toBe('INVALID_TOKEN');
  });

  it('rejects an expired link', async () => {
    await forgot('ada@example.com').expect(202);
    const token = resetToken('ada@example.com');
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    expect(errorOf(await resetWith(token).expect(400)).code).toBe('INVALID_TOKEN');
  });

  it('never accepts an email-verification token as a reset token', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'grace@example.com', password: PASSWORD, displayName: 'Grace' })
      .expect(202);
    const verifyToken = tokenFromLatestEmail('grace@example.com');
    expect(errorOf(await resetWith(verifyToken).expect(400)).code).toBe('INVALID_TOKEN');
  });

  it('enforces the password policy, without burning the link', async () => {
    await forgot('ada@example.com').expect(202);
    const token = resetToken('ada@example.com');
    const rejected = await resetWith(token, 'short').expect(422);
    expect(errorOf(rejected).details?.['password']).toBeDefined();
    await resetWith(token).expect(200);
  });

  it('verifies an unverified account, since the link proves inbox access', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'grace@example.com', password: PASSWORD, displayName: 'Grace' })
      .expect(202);
    await forgot('grace@example.com').expect(202);
    await resetWith(resetToken('grace@example.com')).expect(200);

    const res = await signIn('grace@example.com', NEW_PASSWORD).expect(200);
    expect(authResponseSchema.parse(res.body).user.emailVerified).toBe(true);
  });

  it('lifts a login lockout', async () => {
    for (let i = 0; i < 5; i++) await signIn('ada@example.com', `wrong ${i}`).expect(401);
    await signIn('ada@example.com', PASSWORD).expect(429);

    await forgot('ada@example.com').expect(202);
    await resetWith(resetToken('ada@example.com')).expect(200);
    await signIn('ada@example.com', NEW_PASSWORD).expect(200);
  });

  it('caps reset emails to one inbox at 3 an hour, without saying so', async () => {
    for (let i = 0; i < 4; i++) await forgot('ada@example.com').expect(202);
    const sent = memoryOutbox.filter((m) => m.subject === 'Reset your Confluence password');
    expect(sent).toHaveLength(3);
  });
});
