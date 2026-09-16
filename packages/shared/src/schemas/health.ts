import { z } from 'zod';

export const dependencyStatusSchema = z.object({
  status: z.enum(['up', 'down']),
  /** Round-trip latency of the probe, in milliseconds. */
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
  dependencies: z.object({
    postgres: dependencyStatusSchema,
    redis: dependencyStatusSchema,
    /**
     * Object storage for shared files. Reported, but not part of `status`:
     * calls and chat work without it, so an outage must not pull the API out
     * of rotation.
     */
    storage: dependencyStatusSchema,
    /**
     * Whether the SMTP server accepts us. Reported, but not part of `status`
     * for the same reason as storage: meetings work without email, only new
     * sign-ups stall. Down here means nobody can verify an account.
     */
    mail: dependencyStatusSchema,
  }),
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
