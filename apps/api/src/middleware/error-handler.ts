import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { ERROR_STATUS, type AppError, type ErrorCode } from '@confluence/shared';
import { isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { RateLimiterUnavailableError } from '../lib/rate-limiter.js';

/** Thrown by route and socket handlers for expected, client-facing failures. */
export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Maps an expected failure to the error the client sees. Shared by the HTTP
 * error handler and socket acknowledgements, so both transports speak the
 * same error language. Returns null for anything unexpected: that is a bug,
 * and the caller logs it and answers INTERNAL.
 */
export function toAppError(err: unknown): AppError | null {
  if (err instanceof HttpError) {
    return { code: err.code, message: err.message, ...(err.details && { details: err.details }) };
  }
  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '(root)';
      (details[key] ??= []).push(issue.message);
    }
    return { code: 'VALIDATION_FAILED', message: 'Request validation failed', details };
  }
  // Auth limiters fail closed when Redis is down: refuse rather than allow
  // unlimited password guessing.
  if (err instanceof RateLimiterUnavailableError) {
    return { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable. Try again shortly.' };
  }
  return null;
}

export function internalError(err: unknown): AppError {
  return { code: 'INTERNAL', message: isProduction ? 'Internal server error' : String(err) };
}

/**
 * The single place an HTTP error becomes a response. Express 4 does not
 * forward rejections from async handlers, so routes are wrapped in
 * asyncHandler to get their errors here.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // body-parser failures carry a `type`; without this they would surface as
  // 500s, which both misleads the client and pollutes the error logs.
  const parserType = (err as { type?: unknown }).type;
  if (parserType === 'entity.parse.failed' || parserType === 'entity.too.large') {
    const error: AppError = {
      code: 'VALIDATION_FAILED',
      message: parserType === 'entity.too.large' ? 'Request body too large' : 'Malformed JSON body',
    };
    res.status(parserType === 'entity.too.large' ? 413 : 400).json({ error });
    return;
  }

  const error = toAppError(err);
  if (error) {
    // Expired tokens are routine (every client hits one each 15 minutes).
    const routine = error.code === 'TOKEN_EXPIRED' || error.code === 'REFRESH_STALE';
    logger[routine ? 'debug' : 'warn']({ reqId: req.id, code: error.code }, error.message);
    if (error.code === 'SERVICE_UNAVAILABLE') res.set('Retry-After', '30');
    res.status(ERROR_STATUS[error.code]).json({ error });
    return;
  }

  // Anything reaching here is a bug. Log it fully, tell the client nothing.
  logger.error({ err, reqId: req.id }, 'unhandled error');
  res.status(ERROR_STATUS.INTERNAL).json({ error: internalError(err) });
};
