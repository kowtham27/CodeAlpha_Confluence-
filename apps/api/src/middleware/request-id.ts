import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

// Augmenting express-serve-static-core (not 'express') is what actually reaches
// the Request type Express 4 hands to middleware.
declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

/**
 * Assigns a correlation id per request and echoes it back. Phase 2 propagates
 * the same id into socket event handlers so a user action can be traced across
 * both transports.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && incoming.length <= 128 ? incoming : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
};
