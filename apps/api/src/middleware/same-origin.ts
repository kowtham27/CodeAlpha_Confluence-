import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { HttpError } from './error-handler.js';

/**
 * CSRF defence for the endpoints the refresh cookie authenticates. The cookie
 * is already SameSite=Strict; this is the second layer, for browsers or
 * configurations where that does not hold.
 *
 * Browsers always send Origin on cross-site POSTs and Sec-Fetch-Site on
 * modern engines, so a request carrying either one that is not our web
 * origin is rejected. Requests with neither (curl, server-to-server) are not
 * CSRF vectors: CSRF needs a victim's browser to attach the cookie.
 */
export const requireSameOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');

  if (origin && origin !== env.WEB_ORIGIN) {
    next(new HttpError('FORBIDDEN', 'Cross-origin request rejected.'));
    return;
  }
  if (fetchSite === 'cross-site') {
    next(new HttpError('FORBIDDEN', 'Cross-site request rejected.'));
    return;
  }
  next();
};
