import { Router, type CookieOptions, type Request, type Response } from 'express';
import {
  loginRequestSchema,
  registerRequestSchema,
  resendVerificationRequestSchema,
  verifyEmailRequestSchema,
  type AuthResponse,
  type MessageResponse,
  type VerifyEmailResponse,
} from '@confluence/shared';
import { AUDIT_ACTIONS, audit, requestContext } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limiter.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { HttpError } from '../../middleware/error-handler.js';
import { getAuth, requireAuth } from '../../middleware/require-auth.js';
import { requireSameOrigin } from '../../middleware/same-origin.js';
import * as authService from './auth.service.js';
import {
  findSessionByToken,
  revokeAllSessions,
  revokeSessions,
  rotateSession,
  type IssuedSession,
} from './session.service.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './tokens.js';

export const REFRESH_COOKIE = 'confluence_rt';

/**
 * httpOnly: page JavaScript (and so any XSS) cannot read it.
 * Secure: HTTPS only; browsers make an exception for http://localhost.
 * SameSite=Strict: never attached to cross-site requests.
 * Path=/auth: not sent to any other API route, so it cannot authenticate them.
 */
const REFRESH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/auth',
};

/**
 * Express 4 has no cookie parser. This reads exactly one cookie whose value
 * we generated (base64url, no escaping needed), which avoids a dependency.
 */
function readRefreshCookie(req: Request): string | null {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) {
      const value = rest.join('=');
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function setRefreshCookie(res: Response, session: IssuedSession): void {
  res.cookie(REFRESH_COOKIE, session.refreshToken, {
    ...REFRESH_COOKIE_OPTIONS,
    expires: session.refreshExpiresAt,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
}

async function authResponse(session: IssuedSession): Promise<AuthResponse> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
  return {
    accessToken: session.accessToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user: authService.toPublicUser(user),
  };
}

export const authRouter: Router = Router();

// Tokens and credentials must never be cached by a browser or proxy.
authRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

authRouter.post(
  '/register',
  limitByIp(RATE_LIMITS.register),
  asyncHandler(async (req, res) => {
    const input = registerRequestSchema.parse(req.body);
    await authService.register(input, requestContext(req));
    const body: MessageResponse = {
      message: 'Check your email for a link to verify your account.',
    };
    res.status(202).json(body);
  }),
);

authRouter.post(
  '/verify-email',
  limitByIp(RATE_LIMITS.verifyEmail),
  asyncHandler(async (req, res) => {
    const { token } = verifyEmailRequestSchema.parse(req.body);
    const email = await authService.verifyEmail(token, requestContext(req));
    const body: VerifyEmailResponse = { message: 'Email verified. You can sign in now.', email };
    res.json(body);
  }),
);

authRouter.post(
  '/verify-email/resend',
  asyncHandler(async (req, res) => {
    const { email } = resendVerificationRequestSchema.parse(req.body);
    await authService.resendVerification(email, requestContext(req));
    const body: MessageResponse = {
      message: 'If that address has an unverified account, a new link is on its way.',
    };
    res.status(202).json(body);
  }),
);

authRouter.post(
  '/login',
  requireSameOrigin,
  asyncHandler(async (req, res) => {
    const input = loginRequestSchema.parse(req.body);
    const { session } = await authService.login(input, requestContext(req));
    setRefreshCookie(res, session);
    res.json(await authResponse(session));
  }),
);

authRouter.post(
  '/refresh',
  requireSameOrigin,
  asyncHandler(async (req, res) => {
    const presented = readRefreshCookie(req);
    if (!presented) throw new HttpError('UNAUTHENTICATED', 'No active session.');

    const result = await rotateSession(presented, requestContext(req));
    if (!result.ok) {
      if (result.reason === 'stale') {
        // Another tab won the race and the cookie jar already holds its new
        // token. Keep the cookie; the client retries once.
        throw new HttpError('REFRESH_STALE', 'Session refreshed elsewhere. Retry.');
      }
      clearRefreshCookie(res);
      throw new HttpError(
        'UNAUTHENTICATED',
        result.reason === 'reuse'
          ? 'For your security this session was signed out. Please sign in again.'
          : 'Session expired. Please sign in again.',
      );
    }

    setRefreshCookie(res, result.session);
    res.json(await authResponse(result.session));
  }),
);

authRouter.post(
  '/logout',
  requireSameOrigin,
  asyncHandler(async (req, res) => {
    const presented = readRefreshCookie(req);
    if (presented) {
      const session = await findSessionByToken(presented);
      if (session) {
        await revokeSessions(session.userId, [session.sessionId], 'LOGOUT');
        audit(AUDIT_ACTIONS.LOGOUT, requestContext(req), {
          userId: session.userId,
          metadata: { sessionId: session.sessionId },
        });
      }
    }
    // Idempotent: logging out twice, or without a session, still succeeds.
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

authRouter.post(
  '/logout-all',
  requireSameOrigin,
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const count = await revokeAllSessions(userId, 'LOGOUT_ALL');
    audit(AUDIT_ACTIONS.LOGOUT_ALL, requestContext(req), {
      userId,
      metadata: { sessionsRevoked: String(count) },
    });
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: getAuth(req).userId } });
    if (!user) throw new HttpError('UNAUTHENTICATED', 'Account no longer exists.');
    res.json(authService.toPublicUser(user));
  }),
);
