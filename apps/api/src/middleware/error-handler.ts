import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { ERROR_STATUS, type AppError, type ErrorCode } from '@confluence/shared';
import { isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** Thrown by route handlers for expected, client-facing failures. */
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
 * The single place an error becomes a response. Express 4 does not forward
 * rejections from async handlers automatically, so route handlers must pass
 * errors to next() — the asyncHandler wrapper below does that for them.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    const error: AppError = {
      code: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
    };
    logger.warn({ reqId: req.id, code: err.code }, err.message);
    res.status(ERROR_STATUS[err.code]).json({ error });
    return;
  }

  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '(root)';
      (details[key] ??= []).push(issue.message);
    }
    const error: AppError = {
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      details,
    };
    res.status(ERROR_STATUS.VALIDATION_FAILED).json({ error });
    return;
  }

  // Anything reaching here is a bug. Log it fully, tell the client nothing.
  logger.error({ err, reqId: req.id }, 'unhandled error');
  const error: AppError = {
    code: 'INTERNAL',
    message: isProduction ? 'Internal server error' : String(err),
  };
  res.status(ERROR_STATUS.INTERNAL).json({ error });
};
