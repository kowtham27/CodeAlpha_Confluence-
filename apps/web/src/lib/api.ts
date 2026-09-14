import { healthResponseSchema, type HealthResponse } from '@confluence/shared';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Every response is parsed through the shared Zod schema rather than cast.
 * A server that changes shape becomes a caught error here instead of an
 * undefined deep inside a component.
 */
async function request<T>(path: string, schema: { parse: (data: unknown) => T }): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    // Phase 1 relies on this for the refresh-token cookie.
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  const body: unknown = await response.json().catch(() => null);

  // /healthz answers 503 with a valid, informative body when degraded, so a
  // non-2xx status is not automatically unparseable.
  if (!response.ok && response.status !== 503) {
    throw new ApiError(response.status, `Request to ${path} failed (${response.status})`);
  }

  return schema.parse(body);
}

export const getHealth = (): Promise<HealthResponse> => request('/healthz', healthResponseSchema);
