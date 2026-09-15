import {
  roomJoinRequestSchema,
  roomLeaveRequestSchema,
  SOCKET_EVENTS,
  type FileSummary,
  type MediaState,
  type Participant,
  type PeerLeftReason,
  type RoomJoinResult,
} from '@confluence/shared';
import { AUDIT_ACTIONS, audit, type RequestContext } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { consume, RATE_LIMITS } from '../../lib/rate-limiter.js';
import { roomEvents } from '../../lib/room-events.js';
import { HttpError } from '../../middleware/error-handler.js';
import { handle } from '../../realtime/ack.js';
import { iceServersFor } from '../rtc/turn.js';
import {
  roomChannel,
  userChannel,
  type AppSocket,
  type AppSocketServer,
} from '../../realtime/types.js';
import * as presence from './presence.js';
import { clearScreen, currentSharer, releaseScreen } from './screen-lock.js';
import { admit, recordJoin, recordLeave, toSummary } from './rooms.service.js';

export interface GatewayOptions {
  timing: presence.PresenceTiming;
  /** How often this instance sweeps every room for timed-out entries. */
  sweepMs: number;
}

function socketContext(socket: AppSocket): RequestContext {
  const ua = socket.handshake.headers['user-agent'];
  return {
    ip: socket.handshake.address || null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
  };
}

function announceLeft(
  io: AppSocketServer,
  slug: string,
  participant: Participant,
  reason: PeerLeftReason,
): void {
  io.to(roomChannel(slug)).emit(SOCKET_EVENTS.ROOM_PEER_LEFT, {
    slug,
    userId: participant.userId,
    peerId: participant.peerId,
    reason,
  });
}

/**
 * Frees the screen-share slot if `peerId` holds it, and tells the room.
 * Called at every way a presenter can leave, so the slot never outlives them.
 */
async function freeScreenIfHeld(io: AppSocketServer, slug: string, peerId: string): Promise<void> {
  if (await releaseScreen(slug, peerId)) {
    io.to(roomChannel(slug)).emit(SOCKET_EVENTS.SCREEN_STATE, { slug, sharer: null });
  }
}

/**
 * Takes this socket out of whatever room it is in. Safe to call at any time
 * and more than once: presence removal is compare-and-delete, so a socket
 * that was displaced or whose room ended changes nothing.
 */
async function leaveCurrentRoom(
  io: AppSocketServer,
  socket: AppSocket,
  reason: PeerLeftReason,
): Promise<void> {
  const { roomSlug: slug, userId } = socket.data;
  if (!slug || !userId) return;
  socket.data.roomSlug = undefined;

  await socket.leave(roomChannel(slug));
  await freeScreenIfHeld(io, slug, socket.id);
  const removed = await presence.leavePresence(slug, userId, socket.id);
  if (!removed) return;

  announceLeft(io, slug, removed, reason);
  await recordLeave(slug, userId);
}

/** No room key yet, but a public key to seal one to. */
async function needsRoomKey(roomId: string, userId: string): Promise<boolean> {
  const member = await prisma.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { wrappedRoomKey: true, user: { select: { publicKey: true } } },
  });
  return member !== null && member.wrappedRoomKey === null && member.user.publicKey !== null;
}

async function join(
  io: AppSocketServer,
  socket: AppSocket,
  slug: string,
  media: MediaState,
  timing: presence.PresenceTiming,
): Promise<RoomJoinResult> {
  const { userId } = socket.data;
  if (!userId) throw new HttpError('UNAUTHENTICATED', 'Sign in to continue.');

  const limit = await consume(RATE_LIMITS.roomJoin, userId);
  if (!limit.allowed) throw new HttpError('RATE_LIMITED', 'Slow down and try again.');

  // Admission rules first: existence, ended, locked. Throws with a typed code.
  const { room, role } = await admit(slug, userId);

  // One room per socket: joining another leaves the current one.
  if (socket.data.roomSlug && socket.data.roomSlug !== slug) {
    await leaveCurrentRoom(io, socket, 'left');
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { displayName: true },
  });
  const self: Participant = {
    peerId: socket.id,
    userId,
    displayName: user.displayName,
    role,
    joinedAt: new Date().toISOString(),
    media,
  };

  // Subscribe to the room's broadcasts BEFORE taking a seat and reading the
  // snapshot. In the other order, someone joining in between would be in
  // neither the snapshot nor a peer-joined event, and never appear. This way
  // they can at worst appear in both, which the client dedupes by userId.
  await socket.join(roomChannel(slug));

  const outcome = await presence.joinPresence(slug, self, room.maxParticipants, timing);
  for (const dead of outcome.timedOut) {
    announceLeft(io, slug, dead, 'timeout');
    await freeScreenIfHeld(io, slug, dead.peerId);
  }

  if (!outcome.ok) {
    await socket.leave(roomChannel(slug));
    throw new HttpError('ROOM_FULL', `This meeting is full (${room.maxParticipants} people).`);
  }

  // Same user, other tab or device: that socket is out, this one takes over.
  const previous = outcome.previous;
  if (previous && previous.peerId !== socket.id) {
    io.to(previous.peerId).emit(SOCKET_EVENTS.ROOM_DISPLACED, { slug });
    io.in(previous.peerId).socketsLeave(roomChannel(slug));
    await freeScreenIfHeld(io, slug, previous.peerId);
    socket.to(roomChannel(slug)).emit(SOCKET_EVENTS.ROOM_PEER_LEFT, {
      slug,
      userId,
      peerId: previous.peerId,
      reason: 'displaced',
    });
  }

  socket.data.roomSlug = slug;
  socket.data.displayName = user.displayName;
  await recordJoin(room.id, userId);

  if (previous?.peerId !== socket.id) {
    socket.to(roomChannel(slug)).emit(SOCKET_EVENTS.ROOM_PEER_JOINED, { slug, participant: self });
  }

  const participants = await presence.listParticipants(slug);
  socket.emit(SOCKET_EVENTS.ROOM_PARTICIPANTS, { slug, participants });

  // A newcomer to a room that already has a key needs someone to seal it to
  // them. Ask whoever is here; any holder's client answers automatically.
  if (room.keyCheck && (await needsRoomKey(room.id, userId))) {
    socket.to(roomChannel(slug)).emit(SOCKET_EVENTS.ROOM_KEY_REQUESTED, { slug });
  }

  if (!previous) {
    audit(AUDIT_ACTIONS.ROOM_JOINED, socketContext(socket), { userId, metadata: { slug } });
  }
  return {
    room: toSummary(room, role, participants.length),
    self,
    // Minted per join, valid 12h: the browser never holds a long-lived secret.
    iceServers: iceServersFor(userId),
    screen: await currentSharer(slug),
  };
}

/**
 * Wires room presence onto the socket server. Returns a stop function that
 * clears this instance's timers and listeners, and resolves once every
 * in-flight disconnect cleanup has finished (see createAppServer's shutdown).
 */
export function attachRoomGateway(
  io: AppSocketServer,
  options: GatewayOptions,
): () => Promise<void> {
  const { timing } = options;
  // Disconnect cleanups still running. Shutdown waits for them: they end in a
  // broadcast through the Redis adapter, which must still be connected.
  const inflight = new Set<Promise<void>>();

  io.on('connection', (socket) => {
    socket.on(
      SOCKET_EVENTS.ROOM_JOIN,
      handle(roomJoinRequestSchema, ({ slug, media }) => join(io, socket, slug, media, timing)),
    );

    socket.on(
      SOCKET_EVENTS.ROOM_LEAVE,
      handle(roomLeaveRequestSchema, async ({ slug }) => {
        // Authorization on every event: you can only leave the room you are in.
        if (socket.data.roomSlug !== slug) {
          throw new HttpError('FORBIDDEN', 'You are not in this room.');
        }
        await leaveCurrentRoom(io, socket, 'left');
        return null;
      }),
    );

    // 'disconnecting', not 'disconnect': the socket still knows its rooms.
    // Covers closed tabs, network loss, and revoked sessions alike.
    socket.on('disconnecting', () => {
      const cleanup = leaveCurrentRoom(io, socket, 'disconnected')
        .catch((error: unknown) => {
          logger.error(
            { err: error, socketId: socket.id },
            'failed to clear presence on disconnect',
          );
        })
        .finally(() => inflight.delete(cleanup));
      inflight.add(cleanup);
    });
  });

  // Heartbeat: keep this instance's entries fresh. If the process dies, the
  // beats stop and another instance's sweeper removes the ghosts.
  const beat = setInterval(() => {
    const entries = [...io.of('/').sockets.values()]
      .filter((s) => s.data.roomSlug && s.data.userId)
      .map((s) => ({ slug: s.data.roomSlug ?? '', userId: s.data.userId ?? '', peerId: s.id }));
    presence.heartbeat(entries, timing).catch((error: unknown) => {
      logger.error({ err: error }, 'presence heartbeat failed');
    });
  }, timing.heartbeatMs);

  const sweeper = setInterval(() => {
    presence
      .sweep(timing)
      .then((dead) => {
        for (const [slug, participants] of dead) {
          for (const p of participants) {
            announceLeft(io, slug, p, 'timeout');
            void freeScreenIfHeld(io, slug, p.peerId).catch((error: unknown) =>
              logger.error({ err: error, slug }, 'failed to free screen slot after timeout'),
            );
          }
        }
      })
      .catch((error: unknown) => logger.error({ err: error }, 'presence sweep failed'));
  }, options.sweepMs);

  beat.unref();
  sweeper.unref();

  const onUpdated = (update: { slug: string; name: string; isLocked: boolean }): void => {
    io.to(roomChannel(update.slug)).emit(SOCKET_EVENTS.ROOM_UPDATED, update);
  };

  const onEnded = ({ slug }: { slug: string }): void => {
    io.to(roomChannel(slug)).emit(SOCKET_EVENTS.ROOM_ENDED, { slug });
    io.in(roomChannel(slug)).socketsLeave(roomChannel(slug));
    clearScreen(slug).catch((error: unknown) => {
      logger.error({ err: error, slug }, 'failed to clear screen slot for ended room');
    });
    presence.clearRoom(slug).catch((error: unknown) => {
      logger.error({ err: error, slug }, 'failed to clear presence for ended room');
    });
  };

  const onFileShared = ({ slug, file }: { slug: string; file: FileSummary }): void => {
    io.to(roomChannel(slug)).emit(SOCKET_EVENTS.FILE_SHARED, { slug, file });
  };
  const onFileDeleted = ({ slug, fileId }: { slug: string; fileId: string }): void => {
    io.to(roomChannel(slug)).emit(SOCKET_EVENTS.FILE_DELETED, { slug, fileId });
  };
  const onKeyRequested = ({ slug }: { slug: string }): void => {
    io.to(roomChannel(slug)).emit(SOCKET_EVENTS.ROOM_KEY_REQUESTED, { slug });
  };
  // Only the recipient needs to know, on whichever of their tabs is open.
  const onKeyGranted = ({ slug, userId }: { slug: string; userId: string }): void => {
    io.to(userChannel(userId)).emit(SOCKET_EVENTS.ROOM_KEY_GRANTED, { slug });
  };

  roomEvents.on('room-updated', onUpdated);
  roomEvents.on('room-ended', onEnded);
  roomEvents.on('file-shared', onFileShared);
  roomEvents.on('file-deleted', onFileDeleted);
  roomEvents.on('key-requested', onKeyRequested);
  roomEvents.on('key-granted', onKeyGranted);

  return async () => {
    clearInterval(beat);
    clearInterval(sweeper);
    roomEvents.off('room-updated', onUpdated);
    roomEvents.off('room-ended', onEnded);
    roomEvents.off('file-shared', onFileShared);
    roomEvents.off('file-deleted', onFileDeleted);
    roomEvents.off('key-requested', onKeyRequested);
    roomEvents.off('key-granted', onKeyGranted);
    await Promise.allSettled([...inflight]);
  };
}
