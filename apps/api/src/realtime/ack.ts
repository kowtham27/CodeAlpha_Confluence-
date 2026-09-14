import type { ZodType } from 'zod';
import type { AckCallback } from '@confluence/shared';
import { logger } from '../lib/logger.js';
import { internalError, toAppError } from '../middleware/error-handler.js';

/**
 * Wraps a socket event handler with the two things every handler needs:
 *
 * - Zod validation of the payload (spec: per-event validation). The typed
 *   event map is a compile-time promise about honest clients; this is the
 *   runtime check against dishonest ones.
 * - Exactly one acknowledgement, success or a typed AppError, so a client is
 *   never left waiting and never sees a stack trace.
 *
 * The parameters are `unknown` on purpose: whatever the typings say, the
 * bytes come from the network.
 */
export function handle<P, T>(
  schema: ZodType<P>,
  fn: (payload: P) => Promise<T>,
): (payload: unknown, ack: unknown) => void {
  return (payload, ack) => {
    // A client that does not ask for a result gets no work done either.
    if (typeof ack !== 'function') return;
    const reply = ack as AckCallback<T>;

    Promise.resolve()
      .then(() => fn(schema.parse(payload)))
      .then(
        (data) => reply({ ok: true, data }),
        (error: unknown) => {
          const known = toAppError(error);
          if (!known) logger.error({ err: error }, 'unhandled socket handler error');
          reply({ ok: false, error: known ?? internalError(error) });
        },
      );
  };
}
