import { z } from 'zod';
import { ERROR_CODES } from '../types/result.js';

export const appErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.array(z.string())).optional(),
});

/** The body of every non-2xx API response: `{ error: AppError }`. */
export const apiErrorBodySchema = z.object({ error: appErrorSchema });

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/**
 * Validates a socket acknowledgement (`Ack<T>`) at runtime. Acks arrive over
 * the network like any response, so they are parsed, not cast.
 */
export function ackSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: appErrorSchema }),
  ]);
}
