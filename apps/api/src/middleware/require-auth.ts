import type { Request, RequestHandler } from 'express';
import { isSessionRevoked } from '../modules/auth/session.service.js';
import { verifyAccessToken, type AccessClaims } from '../modules/auth/tokens.js';
import { HttpError } from './error-handler.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessClaims;
  }
}

/**
 * Bearer-token authentication. TOKEN_EXPIRED is distinct from UNAUTHENTICATED
 * so the client knows a silent refresh will fix it, versus a real sign-out.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;

  if (!token) {
    next(new HttpError('UNAUTHENTICATED', 'Sign in to continue.'));
    return;
  }

  verifyAccessToken(token)
    .then(async (result) => {
      if (!result.ok) {
        throw result.reason === 'expired'
          ? new HttpError('TOKEN_EXPIRED', 'Session expired. Refresh and retry.')
          : new HttpError('UNAUTHENTICATED', 'Sign in to continue.');
      }
      if (await isSessionRevoked(result.claims.sessionId)) {
        throw new HttpError('UNAUTHENTICATED', 'This session has been signed out.');
      }
      req.auth = result.claims;
      next();
    })
    .catch(next);
};

/** For handlers behind requireAuth. Throws rather than asserting non-null. */
export function getAuth(req: Request): AccessClaims {
  if (!req.auth) throw new HttpError('UNAUTHENTICATED', 'Sign in to continue.');
  return req.auth;
}
