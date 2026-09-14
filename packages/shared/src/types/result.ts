/**
 * Explicit success/failure at module boundaries, so a caller cannot forget that
 * an operation can fail the way a bare `throw` lets them. Used for expected
 * failures (room full, bad credentials); genuine bugs still throw.
 */
export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  /** Access token expired: the client should refresh and retry once. */
  'TOKEN_EXPIRED',
  /** Refresh lost a benign race with another tab: retry once, do not log out. */
  'REFRESH_STALE',
  'EMAIL_NOT_VERIFIED',
  'INVALID_TOKEN',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'ROOM_FULL',
  'ROOM_LOCKED',
  'ROOM_ENDED',
  /** Someone else holds the room's screen-share slot. */
  'SCREEN_BUSY',
  'CONFLICT',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppError {
  code: ErrorCode;
  message: string;
  /** Field-level detail from Zod. Never contains secrets. */
  details?: Record<string, string[]>;
}

/** HTTP status for each domain error code. Keeps status mapping in one place. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  REFRESH_STALE: 401,
  EMAIL_NOT_VERIFIED: 403,
  INVALID_TOKEN: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  ROOM_FULL: 409,
  ROOM_LOCKED: 409,
  ROOM_ENDED: 410,
  SCREEN_BUSY: 409,
  CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};
