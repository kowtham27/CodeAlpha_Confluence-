import type { Result } from 'ioredis';
import { participantSchema, type Participant } from '@confluence/shared';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';

/**
 * Who is in which room right now. Lives in Redis, not Postgres: it changes on
 * every join and leave, it must be shared by every API instance, and it must
 * clean itself up when an instance dies without saying goodbye.
 *
 * Per room, two keys:
 *   presence:{slug}:beats   ZSET  userId -> last heartbeat (ms)
 *   presence:{slug}:peers   HASH  userId -> Participant JSON
 * plus one global set, presence:rooms, of rooms with anyone in them, which
 * the sweeper walks.
 *
 * One entry per user, not per socket: a second tab replaces the first. Every
 * mutation is a Lua script, so check-then-act sequences (capacity, "is this
 * still my entry?") are atomic across instances.
 */

const ROOMS_KEY = 'presence:rooms';
const beatsKey = (slug: string): string => `presence:${slug}:beats`;
const peersKey = (slug: string): string => `presence:${slug}:peers`;

export interface PresenceTiming {
  /** How often each instance refreshes its own sockets' entries. */
  heartbeatMs: number;
  /** An entry not refreshed for this long belongs to a dead instance. */
  staleMs: number;
}

export const DEFAULT_TIMING: PresenceTiming = { heartbeatMs: 10_000, staleMs: 30_000 };

// Shared by JOIN and SWEEP: remove entries whose heartbeat is too old and
// return their participant JSON so the caller can announce the departures.
const PRUNE = `
local function prune(beats, peers, cutoff)
  local dead = {}
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', beats, 0, cutoff)) do
    local json = redis.call('HGET', peers, id)
    if json then table.insert(dead, json) end
    redis.call('ZREM', beats, id)
    redis.call('HDEL', peers, id)
  end
  return dead
end
`;

/**
 * KEYS: beats, peers, rooms
 * ARGV: now, staleMs, maxParticipants, userId, participantJson, slug
 * Returns { status, previousJson, ...deadJson } with status OK or FULL.
 * A user already present replaces their own entry and is never refused for
 * capacity: they are not taking a new seat.
 */
const JOIN = `${PRUNE}
local beats, peers, rooms = KEYS[1], KEYS[2], KEYS[3]
local now, stale, max = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local userId, json, slug = ARGV[4], ARGV[5], ARGV[6]
local result = { 'OK', '' }
for _, d in ipairs(prune(beats, peers, now - stale)) do table.insert(result, d) end
local previous = redis.call('HGET', peers, userId)
if not previous and redis.call('ZCARD', beats) >= max then
  result[1] = 'FULL'
  return result
end
if previous then result[2] = previous end
redis.call('ZADD', beats, now, userId)
redis.call('HSET', peers, userId, json)
redis.call('PEXPIRE', beats, stale * 4)
redis.call('PEXPIRE', peers, stale * 4)
redis.call('SADD', rooms, slug)
return result
`;

/**
 * Compare-and-delete. KEYS: beats, peers  ARGV: userId, peerId
 * Removes the entry only if it still belongs to this socket. Without the
 * check, a displaced tab disconnecting would delete the new tab's entry.
 */
const LEAVE = `
local json = redis.call('HGET', KEYS[2], ARGV[1])
if not json then return '' end
if cjson.decode(json).peerId ~= ARGV[2] then return '' end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return json
`;

/** KEYS: beats, peers  ARGV: now, userId, peerId, staleMs. Refreshes only our own entry. */
const HEARTBEAT = `
local json = redis.call('HGET', KEYS[2], ARGV[2])
if not json or cjson.decode(json).peerId ~= ARGV[3] then return 0 end
redis.call('ZADD', KEYS[1], 'XX', tonumber(ARGV[1]), ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]) * 4)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[4]) * 4)
return 1
`;

/** KEYS: beats, peers, rooms  ARGV: now, staleMs, slug. Returns dead participant JSON. */
const SWEEP = `${PRUNE}
local dead = prune(KEYS[1], KEYS[2], tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[3], ARGV[3])
  redis.call('DEL', KEYS[1], KEYS[2])
end
return dead
`;

redis.defineCommand('presenceJoin', { numberOfKeys: 3, lua: JOIN });
redis.defineCommand('presenceLeave', { numberOfKeys: 2, lua: LEAVE });
redis.defineCommand('presenceHeartbeat', { numberOfKeys: 2, lua: HEARTBEAT });
redis.defineCommand('presenceSweep', { numberOfKeys: 3, lua: SWEEP });

declare module 'ioredis' {
  interface RedisCommander<Context> {
    presenceJoin(
      beats: string,
      peers: string,
      rooms: string,
      now: number,
      staleMs: number,
      max: number,
      userId: string,
      json: string,
      slug: string,
    ): Result<string[], Context>;
    presenceLeave(
      beats: string,
      peers: string,
      userId: string,
      peerId: string,
    ): Result<string, Context>;
    presenceHeartbeat(
      beats: string,
      peers: string,
      now: number,
      userId: string,
      peerId: string,
      staleMs: number,
    ): Result<number, Context>;
    presenceSweep(
      beats: string,
      peers: string,
      rooms: string,
      now: number,
      staleMs: number,
      slug: string,
    ): Result<string[], Context>;
  }
}

/** Entries are written by this code only, but they round-trip through Redis: validate. */
function parse(json: string): Participant | null {
  try {
    return participantSchema.parse(JSON.parse(json));
  } catch (error) {
    logger.error({ err: error }, 'discarding malformed presence entry');
    return null;
  }
}

const parseAll = (list: string[]): Participant[] =>
  list.map(parse).filter((p): p is Participant => p !== null);

export type JoinOutcome =
  | { ok: true; previous: Participant | null; timedOut: Participant[] }
  | { ok: false; reason: 'full'; timedOut: Participant[] };

export async function joinPresence(
  slug: string,
  participant: Participant,
  maxParticipants: number,
  timing: PresenceTiming,
): Promise<JoinOutcome> {
  const [status, previous = '', ...dead] = await redis.presenceJoin(
    beatsKey(slug),
    peersKey(slug),
    ROOMS_KEY,
    Date.now(),
    timing.staleMs,
    maxParticipants,
    participant.userId,
    JSON.stringify(participant),
    slug,
  );
  const timedOut = parseAll(dead);
  if (status === 'FULL') return { ok: false, reason: 'full', timedOut };
  return { ok: true, previous: previous ? parse(previous) : null, timedOut };
}

/** Removes the user's entry if it still belongs to `peerId`; returns what was removed. */
export async function leavePresence(
  slug: string,
  userId: string,
  peerId: string,
): Promise<Participant | null> {
  const removed = await redis.presenceLeave(beatsKey(slug), peersKey(slug), userId, peerId);
  return removed ? parse(removed) : null;
}

export async function heartbeat(
  entries: { slug: string; userId: string; peerId: string }[],
  timing: PresenceTiming,
): Promise<void> {
  if (entries.length === 0) return;
  const now = Date.now();
  const pipeline = redis.pipeline();
  for (const e of entries) {
    pipeline.presenceHeartbeat(
      beatsKey(e.slug),
      peersKey(e.slug),
      now,
      e.userId,
      e.peerId,
      timing.staleMs,
    );
  }
  await pipeline.exec();
}

/** Prunes every active room; returns who timed out, per room. */
export async function sweep(timing: PresenceTiming): Promise<Map<string, Participant[]>> {
  const result = new Map<string, Participant[]>();
  const now = Date.now();
  for (const slug of await redis.smembers(ROOMS_KEY)) {
    const dead = parseAll(
      await redis.presenceSweep(
        beatsKey(slug),
        peersKey(slug),
        ROOMS_KEY,
        now,
        timing.staleMs,
        slug,
      ),
    );
    if (dead.length > 0) result.set(slug, dead);
  }
  return result;
}

export async function listParticipants(slug: string): Promise<Participant[]> {
  return parseAll(await redis.hvals(peersKey(slug))).sort((a, b) =>
    a.joinedAt.localeCompare(b.joinedAt),
  );
}

/** Live headcount, ignoring entries already stale but not yet swept. */
export async function countParticipants(
  slugs: string[],
  timing: PresenceTiming = DEFAULT_TIMING,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (slugs.length === 0) return counts;
  const cutoff = Date.now() - timing.staleMs;
  const pipeline = redis.pipeline();
  for (const slug of slugs) pipeline.zcount(beatsKey(slug), cutoff, '+inf');
  const replies = (await pipeline.exec()) ?? [];
  slugs.forEach((slug, i) => {
    const count = replies[i]?.[1];
    counts.set(slug, typeof count === 'number' ? count : 0);
  });
  return counts;
}

export async function clearRoom(slug: string): Promise<Participant[]> {
  const everyone = await listParticipants(slug);
  await redis.multi().del(beatsKey(slug), peersKey(slug)).srem(ROOMS_KEY, slug).exec();
  return everyone;
}
