import type {
  GrantRoomKeyRequest,
  InitRoomKeyRequest,
  KeyRequest,
  RoomKeyState,
  SetUserKeysRequest,
  UserKeys,
} from '@confluence/shared';
import { prisma } from '../../lib/prisma.js';
import { roomEvents } from '../../lib/room-events.js';
import { HttpError } from '../../middleware/error-handler.js';
import { fromBase64Url, requireMember, toBase64Url } from '../rooms/membership.js';

/**
 * Key directory and room-key distribution. The server stores public keys and
 * sealed/encrypted blobs, and enforces WHO may write WHAT; it can never open
 * any of it. See ARCHITECTURE.md, "End-to-end keys".
 */

export async function getUserKeys(userId: string): Promise<UserKeys> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicKey: true, encryptedPrivateKey: true },
  });
  return {
    publicKey: user.publicKey ? toBase64Url(user.publicKey) : null,
    encryptedPrivateKey: user.encryptedPrivateKey ? toBase64Url(user.encryptedPrivateKey) : null,
  };
}

/**
 * Set once, only while empty. Replacing a public key would let whoever did it
 * receive every room key sealed to "you" from then on, so an access token
 * (which could be stolen) is not allowed to do it. Keys are only cleared by a
 * password reset, which proves control of the inbox.
 */
export async function setUserKeys(userId: string, keys: SetUserKeysRequest): Promise<void> {
  const updated = await prisma.user.updateMany({
    where: { id: userId, publicKey: null },
    data: {
      publicKey: fromBase64Url(keys.publicKey),
      encryptedPrivateKey: fromBase64Url(keys.encryptedPrivateKey),
    },
  });
  if (updated.count === 0)
    throw new HttpError('CONFLICT', 'Keys are already set up for this account.');
}

export async function getRoomKey(slug: string, userId: string): Promise<RoomKeyState> {
  const { room, member } = await requireMember(slug, userId);
  return {
    keyCheck: room.keyCheck,
    wrappedRoomKey: member.wrappedRoomKey ? toBase64Url(member.wrappedRoomKey) : null,
  };
}

/**
 * Creates the room's key. First writer wins, atomically: two members opening
 * a brand-new room at once cannot end up with two different keys.
 */
export async function initRoomKey(
  slug: string,
  userId: string,
  body: InitRoomKeyRequest,
): Promise<void> {
  const { room, member } = await requireMember(slug, userId);
  const initialised = await prisma.$transaction(async (tx) => {
    const claimed = await tx.room.updateMany({
      where: { id: room.id, keyCheck: null },
      data: { keyCheck: body.keyCheck },
    });
    if (claimed.count === 0) return false;
    await tx.roomMember.update({
      where: { id: member.id },
      data: { wrappedRoomKey: fromBase64Url(body.wrappedRoomKey) },
    });
    return true;
  });
  if (!initialised) throw new HttpError('CONFLICT', 'This room already has a key.');
}

/**
 * Hands the room key to another member, sealed to their public key. Only a
 * member who holds the key may grant it, and only to someone in this room.
 * Never overwrites: a member who already has a key keeps it (a malicious
 * member cannot replace a good key with garbage). The recipient still checks
 * the key against the room's keyCheck before trusting it.
 */
export async function grantRoomKey(
  slug: string,
  granterId: string,
  body: GrantRoomKeyRequest,
): Promise<void> {
  const { room, member: granter } = await requireMember(slug, granterId);
  if (!granter.wrappedRoomKey) throw new HttpError('FORBIDDEN', 'You do not hold this room’s key.');

  const target = await prisma.roomMember.findUnique({
    where: { roomId_userId: { roomId: room.id, userId: body.userId } },
    include: { user: { select: { publicKey: true } } },
  });
  if (!target?.user.publicKey) {
    throw new HttpError('NOT_FOUND', 'That person is not in this room, or has no keys yet.');
  }

  const granted = await prisma.roomMember.updateMany({
    where: { id: target.id, wrappedRoomKey: null },
    data: { wrappedRoomKey: fromBase64Url(body.wrappedRoomKey) },
  });
  if (granted.count > 0) roomEvents.emit('key-granted', { slug, userId: body.userId });
}

/** Members who need the room key and can receive it (they have a public key). */
export async function keyRequests(slug: string, userId: string): Promise<KeyRequest[]> {
  const { room } = await requireMember(slug, userId);
  if (!room.keyCheck) return [];
  const waiting = await prisma.roomMember.findMany({
    where: { roomId: room.id, wrappedRoomKey: null, user: { publicKey: { not: null } } },
    include: { user: { select: { id: true, displayName: true, publicKey: true } } },
    take: 50,
  });
  return waiting.flatMap(({ user }) =>
    user.publicKey
      ? [{ userId: user.id, displayName: user.displayName, publicKey: toBase64Url(user.publicKey) }]
      : [],
  );
}

/**
 * Drops the caller's own sealed key, for when it cannot be opened (keys were
 * reset) or failed its keyCheck. Asks holders to grant a fresh one.
 */
export async function clearMyRoomKey(slug: string, userId: string): Promise<void> {
  const { member } = await requireMember(slug, userId);
  await prisma.roomMember.update({ where: { id: member.id }, data: { wrappedRoomKey: null } });
  roomEvents.emit('key-requested', { slug });
}
