import { createHmac } from 'node:crypto';
import type { IceServer } from '@confluence/shared';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/** TURN credentials are valid for 12 hours. */
export const TURN_CREDENTIAL_TTL_SECONDS = 12 * 60 * 60;

/**
 * Generate short-lived credentials for local coturn.
 *
 * Username:
 *   <expiry>:<userId>
 *
 * Credential:
 *   base64(HMAC-SHA1(secret, username))
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

  return {
    username,
    credential,
  };
}

type CloudflareTurnResponse = {
  iceServers: IceServer[];
};

/**
 * Generate temporary ICE server credentials from Cloudflare Realtime TURN.
 *
 * The Cloudflare API token stays on the backend.
 */
async function cloudflareIceServers(): Promise<IceServer[]> {
  const tokenId = env.CLOUDFLARE_TURN_TOKEN_ID;
  const apiToken = env.CLOUDFLARE_TURN_API_TOKEN;

  if (!tokenId || !apiToken) {
    throw new Error(
      'Cloudflare TURN requires CLOUDFLARE_TURN_TOKEN_ID and CLOUDFLARE_TURN_API_TOKEN',
    );
  }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
      tokenId,
    )}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ttl: TURN_CREDENTIAL_TTL_SECONDS,
      }),
      // Joining waits on this call: fail fast rather than hang the room.
      signal: AbortSignal.timeout(5_000),
    },
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(`Cloudflare TURN credential request failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as CloudflareTurnResponse;

  if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
    throw new Error('Cloudflare TURN returned no ICE servers');
  }

  return data.iceServers;
}

/**
 * Support an existing hosted TURN configuration.
 */
function hostedIceServers(urls: string): IceServer[] {
  const list = urls
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  const stun = list.filter((url) => url.startsWith('stun:'));
  const turn = list.filter((url) => !url.startsWith('stun:'));

  return [
    ...stun.map((url) => ({
      urls: url,
    })),

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

/**
 * Return ICE servers for a WebRTC user.
 *
 * Priority:
 *
 * 1. Cloudflare Realtime TURN
 * 2. Existing hosted TURN configuration
 * 3. Local coturn fallback
 */
export async function iceServersFor(userId: string): Promise<IceServer[]> {
  // ------------------------------------------------------------
  // 1. Cloudflare Realtime TURN
  // ------------------------------------------------------------
  if (env.CLOUDFLARE_TURN_TOKEN_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
    try {
      return await cloudflareIceServers();
    } catch (error) {
      // Cloudflare being down must not stop people meeting: most calls
      // connect browser-to-browser and never touch the relay. Fall through
      // to whatever else is configured, and say so loudly in the log.
      logger.error({ err: error }, 'Cloudflare TURN unavailable; falling back');
    }
  }

  // ------------------------------------------------------------
  // 2. Existing hosted TURN
  // ------------------------------------------------------------
  if (env.TURN_URLS) {
    return hostedIceServers(env.TURN_URLS);
  }

  // ------------------------------------------------------------
  // 3. Local coturn fallback
  // ------------------------------------------------------------
  const address = `${env.TURN_HOST}:${env.TURN_PORT}`;

  const { username, credential } = turnCredentials(userId);

  return [
    {
      urls: `stun:${address}`,
    },
    {
      urls: [`turn:${address}?transport=udp`, `turn:${address}?transport=tcp`],
      username,
      credential,
    },
  ];
}
