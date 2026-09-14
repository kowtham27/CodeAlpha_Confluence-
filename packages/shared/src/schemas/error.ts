import { z } from 'zod';
import { ERROR_CODES } from '../types/result.js';

/** The body of every non-2xx API response: `{ error: AppError }`. */
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
