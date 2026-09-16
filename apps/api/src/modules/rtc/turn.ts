import { createHmac } from 'node:crypto';
import type { IceServer } from '@confluence/shared';
import { env } from '../../config/env.js';

/** Spec: short-lived TURN credentials, valid 12 hours. */
export const TURN_CREDENTIAL_TTL_SECONDS = 12 * 60 * 60;

/**
 * coturn's "TURN REST API" credentials (use-auth-secret). coturn and the API
 * share TURN_STATIC_AUTH_SECRET; the API mints
 *
 *   username   = "<unix expiry>:<userId>"
 *   credential = base64(HMAC-SHA1(secret, username))
 *
 * and coturn recomputes the HMAC to check it, rejecting expired usernames.
 * No TURN secret ever reaches a browser, credentials die on their own, and
 * the userId in the username shows up in coturn's logs for abuse tracing.
 * SHA-1 is what coturn implements for this scheme; as an HMAC it is not
 * subject to SHA-1's collision weakness.
 */
export function turnCredentials(
  userId: string,
  nowMs: number = Date.now(),
): { username: string; credential: string } {
  const expiry = Math.floor(nowMs / 1000) + TURN_CREDENTIAL_TTL_SECONDS;
  const username = `${expiry}:${userId}`;
  const credential = createHmac('sha1', env.TURN_STATIC_AUTH_SECRET ?? '')
    .update(username)
    .digest('base64');
  return { username, credential };
}

/**
 * A hosted TURN service (Metered, Twilio, Cloudflare...) issues one fixed
 * credential instead, so there is no secret to share and nothing to run: the
 * URLs it gives us are passed to the browser as they are.
 */
function hostedIceServers(urls: string): IceServer[] {
  const list = urls
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const stun = list.filter((url) => url.startsWith('stun:'));
  const turn = list.filter((url) => !url.startsWith('stun:'));
  return [
    ...stun.map((url) => ({ urls: url })),
    ...(turn.length > 0
      ? [
          {
            urls: turn,
            username: env.TURN_USERNAME ?? '',
            credential: env.TURN_PASSWORD ?? '',
          },
        ]
      : []),
  ];
}

export function iceServersFor(userId: string): IceServer[] {
  if (env.TURN_URLS) return hostedIceServers(env.TURN_URLS);

  const address = `${env.TURN_HOST}:${env.TURN_PORT}`;
  const { username, credential } = turnCredentials(userId);
  return [
    { urls: `stun:${address}` },
    {
      // UDP first; TCP for networks that block UDP outright.
      urls: [`turn:${address}?transport=udp`, `turn:${address}?transport=tcp`],
      username,
      credential,
    },
  ];
}
