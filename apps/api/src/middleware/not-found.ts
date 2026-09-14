import type { RequestHandler } from 'express';
import { ERROR_STATUS, type AppError } from '@confluence/shared';

export const notFound: RequestHandler = (_req, res) => {
  const error: AppError = { code: 'NOT_FOUND', message: 'Route not found' };
  res.status(ERROR_STATUS.NOT_FOUND).json({ error });
};
