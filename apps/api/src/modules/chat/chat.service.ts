import type { ChatHistoryResponse, ChatMessage } from '@confluence/shared';
import type { Message } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/error-handler.js';
import { fromBase64Url, requireMember, toBase64Url } from '../rooms/membership.js';

/**
 * Chat storage. Messages arrive as [24-byte nonce][ciphertext] under the
 * room key; they are stored split into the schema's `nonce` and
 * `ciphertext` columns (there is no plaintext column) and joined again on
 * the way out. Nothing here can read them.
 */

const NONCE_BYTES = 24;
/** Nonce plus at least the 16-byte authentication tag. */
const MIN_SEALED_BYTES = NONCE_BYTES + 16;
const HISTORY_PAGE = 50;

type WithSender = Message & { sender: { id: string; displayName: string } };
const withSender = { sender: { select: { id: true, displayName: true } } } as const;

function toChatMessage(row: WithSender): ChatMessage {
  const sealed = new Uint8Array(row.nonce.length + row.ciphertext.length);
  sealed.set(row.nonce);
  sealed.set(row.ciphertext, row.nonce.length);
  return {
    id: row.id,
    sender: { userId: row.sender.id, displayName: row.sender.displayName },
    ciphertext: toBase64Url(sealed),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function sendMessage(
  slug: string,
  senderId: string,
  id: string,
  ciphertext: string,
): Promise<ChatMessage> {
  const { room } = await requireMember(slug, senderId);
  if (room.endedAt) throw new HttpError('ROOM_ENDED', 'This meeting has ended.');

  const sealed = fromBase64Url(ciphertext);
  if (sealed.length < MIN_SEALED_BYTES) {
    throw new HttpError('VALIDATION_FAILED', 'That is not an encrypted message.');
  }

  // A retried send (the ack was lost) must not post the message twice.
  const existing = await prisma.message.findUnique({ where: { id }, include: withSender });
  if (existing) {
    if (existing.senderId !== senderId || existing.roomId !== room.id) {
      throw new HttpError('CONFLICT', 'That message id is taken.');
    }
    return toChatMessage(existing);
  }

  const row = await prisma.message.create({
    data: {
      id,
      roomId: room.id,
      senderId,
      nonce: sealed.slice(0, NONCE_BYTES),
      ciphertext: sealed.slice(NONCE_BYTES),
    },
    include: withSender,
  });
  return toChatMessage(row);
}

/** Newest page first by default; `before` pages further back. Members only. */
export async function history(
  slug: string,
  userId: string,
  before: string | undefined,
): Promise<ChatHistoryResponse> {
  const { room } = await requireMember(slug, userId);
  const rows = await prisma.message.findMany({
    where: { roomId: room.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: HISTORY_PAGE + 1,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
    include: withSender,
  });
  const page = rows.slice(0, HISTORY_PAGE).reverse();
  return { messages: page.map(toChatMessage), hasMore: rows.length > HISTORY_PAGE };
}
