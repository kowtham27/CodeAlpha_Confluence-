import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { limitByIp, RATE_LIMITS } from './lib/rate-limiter.js';
import { requestId } from './middleware/request-id.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { authRouter } from './modules/auth/auth.router.js';
import { filesRouter } from './modules/files/files.router.js';
import { healthRouter } from './modules/health/health.router.js';
import { keysRouter } from './modules/keys/keys.router.js';
import { roomsRouter } from './modules/rooms/rooms.router.js';

/**
 * Builds the Express app without binding a port, so tests can drive it with
 * supertest and no listening socket. main.ts owns the listen call.
 */
export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy in production; needed for correct client IPs, which
  // the Phase 1 rate limiter and the audit log both depend on.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { id?: string }).id ?? 'unknown',
      // Health checks are polled constantly; logging each one buries real traffic.
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/livez' },
    }),
  );

  // Phase 7 replaces this with a strict nonce-based CSP. The defaults are a
  // reasonable floor for an API that serves only JSON.
  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }),
  );

  // Spec section 7: exact-origin allowlist, never a wildcard. credentials:true
  // is required for the Phase 1 refresh-token cookie.
  app.use(
    cors({
      origin: [env.WEB_ORIGIN],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      // Browsers default to re-sending the preflight after 5s; every
      // authenticated call is cross-origin, so cache it for 10 minutes.
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: '1mb' }));

  // Health first: orchestrators poll it constantly and must never be limited.
  app.use(healthRouter);

  // Spec: 100 requests per minute per IP, Redis-backed so it holds across
  // instances. Auth routes add stricter per-subject limits on top.
  app.use(limitByIp(RATE_LIMITS.globalIp));

  app.use('/auth', authRouter);
  app.use('/rooms', roomsRouter);
  // Both define full paths (/me/keys, /rooms/:slug/key, /rooms/:slug/files).
  app.use(keysRouter);
  app.use(filesRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
