import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 swallows rejected promises from async handlers, which turns a
 * failed await into a request that hangs until timeout. Every async route is
 * wrapped in this so rejections reach the error handler.
 * (Express 5 does this natively; see ARCHITECTURE.md for why we stayed on 4.)
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
