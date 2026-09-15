import {
  apiErrorBodySchema,
  healthResponseSchema,
  type ErrorCode,
  type HealthResponse,
} from '@confluence/shared';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** NETWORK when the request never got an HTTP response at all. */
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Schema<T> {
  parse: (data: unknown) => T;
}

/**
 * The auth layer registers these at startup. Keeping them injected (rather
 * than imported) avoids a cycle: the session code itself calls request().
 */
interface TokenSource {
  current: () => string | null;
  refresh: () => Promise<string | null>;
}

let tokens: TokenSource = { current: () => null, refresh: () => Promise.resolve(null) };

export function setTokenSource(source: TokenSource): void {
  tokens = source;
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema?: Schema<T>;
  /** Attach the access token and refresh once on TOKEN_EXPIRED. */
  auth?: boolean;
}

async function send(path: string, method: string, body: unknown, token: string | null) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    return await fetch(`${API_URL}${path}`, {
      method,
      headers,
      // Required for the refresh cookie on /auth routes.
      credentials: 'include',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const parsed = apiErrorBodySchema.safeParse(await response.json().catch(() => null));
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(response.status, code, message, details);
  }
  return new ApiError(response.status, 'INTERNAL', `Unexpected response (${response.status}).`);
}

/**
 * Every response body is parsed through the shared Zod schema rather than
 * cast, so a server that changes shape fails here, loudly, instead of
 * producing undefined deep inside a component.
 */
export async function request<T = void>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const { method = 'GET', body, schema, auth = false } = options;

  let response = await send(path, method, body, auth ? tokens.current() : null);

  if (auth && response.status === 401) {
    const error = await toApiError(response);
    if (error.code !== 'TOKEN_EXPIRED') throw error;
    const fresh = await tokens.refresh();
    if (!fresh) throw error;
    response = await send(path, method, body, fresh);
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204 || !schema) return undefined as T;
  return schema.parse(await response.json());
}

/** /healthz answers 503 with a valid body when degraded, so it bypasses request(). */
export async function getHealth(): Promise<HealthResponse> {
  const response = await send('/healthz', 'GET', undefined, null);
  return healthResponseSchema.parse(await response.json());
}
