import type { Result } from 'ioredis';
import { screenSharerSchema, type ScreenSharer } from '@confluence/shared';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';

/**
 * The room's single screen-share slot (spec: one presenter at a time, the
 * server arbitrates through a lock held in Redis).
 *
 *   screen:{slug}   STRING   ScreenSharer JSON of the current presenter
 *
 * No TTL: instead, a claim may take over a lock whose holder no longer holds
 * a seat in the room. That covers every way a presenter can vanish (left,
 * disconnected, their server crashed and presence swept them) without a
 * timer that could expire mid-presentation.
 */

const lockKey = (slug: string): string => `screen:${slug}`;
const peersKey = (slug: string): string => `presence:${slug}:peers`;

/**
 * KEYS: lock, peers  ARGV: peerId, sharerJson
 * Returns { 'OK' | 'BUSY', currentJson }.
 */
const CLAIM = `
local current = redis.call('GET', KEYS[1])
if current then
  local holder = cjson.decode(current)
  if holder.peerId == ARGV[1] then return { 'OK', current } end
  local seat = redis.call('HGET', KEYS[2], holder.userId)
  if seat and cjson.decode(seat).peerId == holder.peerId then return { 'BUSY', current } end
end
redis.call('SET', KEYS[1], ARGV[2])
return { 'OK', ARGV[2] }
`;

/** KEYS: lock  ARGV: peerId. Deletes only if this peer holds it. */
const RELEASE = `
local current = redis.call('GET', KEYS[1])
if current and cjson.decode(current).peerId == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

redis.defineCommand('screenClaim', { numberOfKeys: 2, lua: CLAIM });
redis.defineCommand('screenRelease', { numberOfKeys: 1, lua: RELEASE });

declare module 'ioredis' {
  interface RedisCommander<Context> {
    screenClaim(
      lock: string,
      peers: string,
      peerId: string,
      json: string,
    ): Result<string[], Context>;
    screenRelease(lock: string, peerId: string): Result<number, Context>;
  }
}

function parse(json: string | null | undefined): ScreenSharer | null {
  if (!json) return null;
  try {
    return screenSharerSchema.parse(JSON.parse(json));
  } catch (error) {
    logger.error({ err: error }, 'discarding malformed screen lock');
    return null;
  }
}

export type ClaimOutcome = { ok: true; sharer: ScreenSharer } | { ok: false; holder: ScreenSharer };

export async function claimScreen(slug: string, sharer: ScreenSharer): Promise<ClaimOutcome> {
  const [status, current] = await redis.screenClaim(
    lockKey(slug),
    peersKey(slug),
    sharer.peerId,
    JSON.stringify(sharer),
  );
  const holder = parse(current);
  if (status === 'BUSY' && holder) return { ok: false, holder };
  return { ok: true, sharer: holder ?? sharer };
}

/** True if `peerId` held the lock and it is now free. */
export async function releaseScreen(slug: string, peerId: string): Promise<boolean> {
  return (await redis.screenRelease(lockKey(slug), peerId)) === 1;
}

/** The current presenter, if they still hold a seat; a stale lock reads as none. */
export async function currentSharer(slug: string): Promise<ScreenSharer | null> {
  const holder = parse(await redis.get(lockKey(slug)));
  if (!holder) return null;
  const seat = await redis.hget(peersKey(slug), holder.userId);
  const seated =
    seat !== null && (JSON.parse(seat) as { peerId?: string }).peerId === holder.peerId;
  return seated ? holder : null;
}

export async function clearScreen(slug: string): Promise<void> {
  await redis.del(lockKey(slug));
}
