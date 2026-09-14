import request from 'supertest';
import { z } from 'zod';
import { authResponseSchema, type AuthResponse } from '@confluence/shared';
import { memoryOutbox } from '../src/lib/mailer.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { REFRESH_COOKIE } from '../src/modules/auth/auth.router.js';

export { argon2Params } from './argon2.js';

/** An Express app or a Node http.Server: supertest drives either. */
export type TestTarget = Parameters<typeof request>[0];

export const WEB_ORIGIN = process.env['WEB_ORIGIN'] ?? 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';

/**
 * Clears all data between tests. DELETE rather than TRUNCATE: TRUNCATE
 * allocates and fsyncs a new file per table, which costs ~3s per reset on
 * Docker Desktop's virtual disk; DELETE on tables this small is milliseconds.
 * Deleting users cascades to every user-owned table (see onDelete: Cascade in
 * schema.prisma). A future table NOT owned by a user must be added here.
 */
export async function resetState(): Promise<void> {
  await prisma.$transaction([prisma.auditLog.deleteMany(), prisma.user.deleteMany()]);
  await redis.flushdb();
  memoryOutbox.length = 0;
}

/** Pulls the verification token out of the most recent email to `to`. */
export function tokenFromLatestEmail(to: string): string {
  // Addresses are normalised to lowercase before sending.
  const mail = memoryOutbox.findLast((m) => m.to === to.toLowerCase());
  const token = mail?.text.match(/#token=([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error(`no verification link emailed to ${to}`);
  return token;
}

export function refreshCookieFrom(res: request.Response): string | null {
  const raw: unknown = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? (raw as string[]) : [];
  const match = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  const value = match?.split(';')[0]?.slice(REFRESH_COOKIE.length + 1);
  return value ? value : null;
}

const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

/** Parses an error response instead of reaching into supertest's untyped body. */
export const errorOf = (res: request.Response): z.infer<typeof errorBodySchema>['error'] =>
  errorBodySchema.parse(res.body).error;

export const cookieHeader = (token: string): string => `${REFRESH_COOKIE}=${token}`;

export async function registerAndVerify(
  app: TestTarget,
  email = 'ada@example.com',
  displayName = 'Ada',
): Promise<void> {
  await request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD, displayName })
    .expect(202);
  await request(app)
    .post('/auth/verify-email')
    .send({ token: tokenFromLatestEmail(email) })
    .expect(200);
}

export interface LoggedIn {
  auth: AuthResponse;
  refreshToken: string;
}

export async function login(app: TestTarget, email = 'ada@example.com'): Promise<LoggedIn> {
  const res = await request(app)
    .post('/auth/login')
    .set('Origin', WEB_ORIGIN)
    .send({ email, password: PASSWORD })
    .expect(200);
  const refreshToken = refreshCookieFrom(res);
  if (!refreshToken) throw new Error('login did not set a refresh cookie');
  return { auth: authResponseSchema.parse(res.body), refreshToken };
}

export function refresh(app: TestTarget, refreshToken: string): request.Test {
  return request(app)
    .post('/auth/refresh')
    .set('Origin', WEB_ORIGIN)
    .set('Cookie', cookieHeader(refreshToken));
}
