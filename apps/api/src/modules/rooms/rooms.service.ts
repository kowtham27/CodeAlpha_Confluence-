import { randomBytes } from 'node:crypto';
import type { RoomRole, RoomSummary, UpdateRoomRequest } from '@confluence/shared';
import { Prisma, type Room, type RoomMember } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { roomEvents } from '../../lib/room-events.js';
import { HttpError } from '../../middleware/error-handler.js';
import { countParticipants } from './presence.js';

/**
 * 9 random bytes, base64url: 12 characters, 72 bits. Rooms are joined by
 * link, so the slug is the only thing between a stranger and the meeting;
 * 72 bits cannot be enumerated at any request rate the API would allow.
 */
export function generateSlug(): string {
  return randomBytes(9).toString('base64url');
}

type RoomWithOwner = Room & { owner: { displayName: string } };

export function toSummary(
  room: RoomWithOwner,
  myRole: RoomRole | null,
  count: number,
): RoomSummary {
  return {
    slug: room.slug,
    name: room.name,
    isLocked: room.isLocked,
    maxParticipants: room.maxParticipants,
    createdAt: room.createdAt.toISOString(),
    endedAt: room.endedAt?.toISOString() ?? null,
    owner: { displayName: room.owner.displayName },
    myRole,
    participantCount: count,
  };
}

const withOwner = { owner: { select: { displayName: true } } } as const;

async function findRoom(slug: string): Promise<RoomWithOwner> {
  const room = await prisma.room.findUnique({ where: { slug }, include: withOwner });
  if (!room) throw new HttpError('NOT_FOUND', 'This room does not exist. Check the link.');
  return room;
}

function findMembership(roomId: string, userId: string): Promise<RoomMember | null> {
  return prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
}

async function summarize(room: RoomWithOwner, myRole: RoomRole | null): Promise<RoomSummary> {
  const counts = await countParticipants([room.slug]);
  return toSummary(room, myRole, counts.get(room.slug) ?? 0);
}

export async function createRoom(ownerId: string, name: string): Promise<RoomSummary> {
  // A collision on 72 random bits will not happen in practice, but a retry
  // is cheaper than reasoning about it.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const room = await prisma.room.create({
        data: {
          slug: generateSlug(),
          name,
          ownerId,
          members: { create: { userId: ownerId, role: 'OWNER' } },
        },
        include: withOwner,
      });
      return toSummary(room, 'OWNER', 0);
    } catch (error) {
      const collision =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      if (!collision) throw error;
    }
  }
  throw new HttpError('CONFLICT', 'Could not create the room. Try again.');
}

/** Rooms the user owns or has joined: live ones first, newest first. */
export async function listRooms(userId: string): Promise<RoomSummary[]> {
  const memberships = await prisma.roomMember.findMany({
    where: { userId },
    include: { room: { include: withOwner } },
    take: 50,
    orderBy: { joinedAt: 'desc' },
  });
  const counts = await countParticipants(memberships.map((m) => m.room.slug));
  return memberships
    .map((m) => toSummary(m.room, m.role, counts.get(m.room.slug) ?? 0))
    .sort((a, b) => {
      if ((a.endedAt === null) !== (b.endedAt === null)) return a.endedAt === null ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
}

/**
 * Any signed-in user with the link may look a room up; that is how the join
 * page learns the room's name and whether it is still open.
 */
export async function getRoom(slug: string, userId: string): Promise<RoomSummary> {
  const room = await findRoom(slug);
  const membership = await findMembership(room.id, userId);
  return summarize(room, membership?.role ?? null);
}

export async function updateRoom(
  slug: string,
  userId: string,
  patch: UpdateRoomRequest,
): Promise<RoomSummary> {
  const room = await findRoom(slug);
  const membership = await findMembership(room.id, userId);
  if (membership?.role !== 'OWNER' && membership?.role !== 'MODERATOR') {
    throw new HttpError('FORBIDDEN', 'Only the host can change this room.');
  }
  if (room.endedAt) throw new HttpError('ROOM_ENDED', 'This meeting has ended.');

  const updated = await prisma.room.update({
    where: { id: room.id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.isLocked !== undefined ? { isLocked: patch.isLocked } : {}),
    },
    include: withOwner,
  });
  roomEvents.emit('room-updated', {
    slug: updated.slug,
    name: updated.name,
    isLocked: updated.isLocked,
  });
  return summarize(updated, membership.role);
}

/** Owner only. Idempotent: ending an ended room is a no-op, not an error. */
export async function endRoom(slug: string, userId: string): Promise<void> {
  const room = await findRoom(slug);
  if (room.ownerId !== userId) {
    throw new HttpError('FORBIDDEN', 'Only the host can end this meeting.');
  }
  if (room.endedAt) return;

  await prisma.room.update({ where: { id: room.id }, data: { endedAt: new Date() } });
  roomEvents.emit('room-ended', { slug });
}

export interface JoinableRoom {
  room: RoomWithOwner;
  role: RoomRole;
  isMember: boolean;
}

/**
 * Server-side admission rules (spec: never trust the client). Capacity is
 * checked later, atomically, in the presence script; everything else is here.
 */
export async function admit(slug: string, userId: string): Promise<JoinableRoom> {
  const room = await findRoom(slug);
  if (room.endedAt) throw new HttpError('ROOM_ENDED', 'This meeting has ended.');

  const membership = await findMembership(room.id, userId);
  // Locking keeps newcomers out, not people already admitted: someone whose
  // connection dropped must be able to get back into their own meeting.
  if (room.isLocked && !membership) {
    throw new HttpError('ROOM_LOCKED', 'The host has locked this meeting.');
  }
  return { room, role: membership?.role ?? 'GUEST', isMember: membership !== null };
}

export async function recordJoin(roomId: string, userId: string): Promise<void> {
  await prisma.roomMember.upsert({
    where: { roomId_userId: { roomId, userId } },
    create: { roomId, userId, role: 'GUEST' },
    update: { leftAt: null },
  });
}

export async function recordLeave(slug: string, userId: string): Promise<void> {
  await prisma.roomMember.updateMany({
    where: { userId, room: { slug } },
    data: { leftAt: new Date() },
  });
}
