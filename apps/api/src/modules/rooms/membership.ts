import type { Room, RoomMember } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/error-handler.js';

/**
 * Shared authorization for everything scoped to a room's members: files,
 * keys. Membership (a RoomMember row) is what counts, not live presence, so
 * people can fetch a meeting's files after it ends.
 */
export async function requireMember(
  slug: string,
  userId: string,
): Promise<{ room: Room; member: RoomMember }> {
  const room = await prisma.room.findUnique({ where: { slug } });
  if (!room) throw new HttpError('NOT_FOUND', 'This room does not exist.');
  const member = await prisma.roomMember.findUnique({
    where: { roomId_userId: { roomId: room.id, userId } },
  });
  if (!member) throw new HttpError('FORBIDDEN', 'Join this room first.');
  return { room, member };
}

export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(text, 'base64url'));
