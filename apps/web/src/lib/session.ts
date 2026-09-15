import { authResponseSchema, type LoginRequest } from '@confluence/shared';
import { useAuth } from '../stores/auth';
import { ApiError, request, setTokenSource } from './api';
import { unlockWithPassword } from './keys/keystore';

const REFRESH_LOCK = 'confluence-auth-refresh';
const channel =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('confluence-auth');

let inflight: Promise<string | null> | null = null;

async function refreshOnce(): Promise<string | null> {
  // One retry for REFRESH_STALE: another tab rotated first and the shared
  // cookie jar already holds its new token, so a second attempt succeeds.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const session = await request('/auth/refresh', {
        method: 'POST',
        schema: authResponseSchema,
      });
      useAuth.getState().setSession(session);
      return session.accessToken;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'REFRESH_STALE' && attempt === 0) continue;
      if (error instanceof ApiError && error.status === 401) {
        const wasSignedIn = useAuth.getState().status === 'authenticated';
        useAuth
          .getState()
          .signOut(wasSignedIn ? 'Your session ended. Please sign in again.' : undefined);
        return null;
      }
      throw error;
    }
  }
  return null;
}

/**
 * Exchanges the httpOnly refresh cookie for a new access token.
 *
 * Single-flight within a tab (concurrent 401s share one refresh), and
 * serialised across tabs with the Web Locks API. The cookie jar is shared
 * between tabs, so without the lock two tabs would present the same refresh
 * token at once, and the server's rotation would see the second as a replay.
 */
export function refreshAccessToken(): Promise<string | null> {
  inflight ??= refreshAcrossTabs().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function refreshAcrossTabs(): Promise<string | null> {
  // Web Locks is universal in current browsers; fall back rather than fail.
  if (!('locks' in navigator)) return refreshOnce();
  // request() resolves with the callback's return value, itself a promise;
  // awaiting flattens it.
  return await navigator.locks.request(REFRESH_LOCK, refreshOnce);
}

setTokenSource({
  current: () => useAuth.getState().accessToken,
  refresh: refreshAccessToken,
});

/** Called once at startup: restores the session from the refresh cookie, if any. */
export async function bootstrapSession(): Promise<void> {
  try {
    await refreshAccessToken();
  } catch {
    // Network failure at boot: show the sign-in page rather than hang.
    useAuth.getState().signOut();
  }
}

export async function login(input: LoginRequest): Promise<void> {
  const session = await request('/auth/login', {
    method: 'POST',
    body: input,
    schema: authResponseSchema,
  });
  // The one moment we hold the password: unlock (or, the first time, create)
  // the end-to-end keys with it, BEFORE the session is set. Setting it sends
  // the user on (the sign-in page redirects at once, often to an invite
  // link), and a page load mid-setup would lose the password with the key
  // not yet saved. Argon2id makes this take about a second. It never fails
  // sign-in; a problem shows up where keys are used.
  await unlockWithPassword(session.user.id, input.password, session.accessToken);
  useAuth.getState().setSession(session);
}

export async function logout(): Promise<void> {
  useAuth.getState().beginSignOut();
  try {
    await request('/auth/logout', { method: 'POST' });
  } finally {
    useAuth.getState().signOut();
    channel?.postMessage('signed-out');
  }
}

export async function logoutEverywhere(): Promise<void> {
  useAuth.getState().beginSignOut();
  try {
    await request('/auth/logout-all', { method: 'POST', auth: true });
  } finally {
    useAuth.getState().signOut('You signed out of every device.');
    channel?.postMessage('signed-out');
  }
}

// Other tabs of this browser follow a sign-out immediately.
channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.data === 'signed-out' && useAuth.getState().status === 'authenticated') {
    useAuth.getState().signOut('You signed out in another tab.');
  }
});
