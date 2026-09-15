import {
  MAX_BOARD_ELEMENTS,
  type BoardOp,
  type BoardSnapshot,
  type BoardStoredElement,
} from '@confluence/shared';
import { Prisma, type WhiteboardOp } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/error-handler.js';
import { requireMember } from '../rooms/membership.js';

/**
 * The whiteboard's source of truth (spec Phase 6).
 *
 * Elements arrive encrypted with the room key; this module never sees what
 * they are. It keeps the board consistent anyway:
 *
 * - Order. Every change takes the next value of `Room.boardSeq` inside its
 *   own transaction. The row lock that increment takes also serialises
 *   concurrent changes to one room, so the element cap below cannot race.
 * - Compaction. Only live elements are stored: re-adding an id replaces its
 *   row, erasing deletes rows, clearing deletes them all. A board that has
 *   been drawn on for hours is as cheap to load as its current picture.
 */

type Tx = Prisma.TransactionClient;

const toStored = (row: WhiteboardOp): BoardStoredElement => ({
  id: row.elementId,
  seq: row.seq,
  ciphertext: (row.payload as { ciphertext: string }).ciphertext,
  authorId: row.authorId,
});

async function nextSeq(tx: Tx, roomId: string): Promise<number> {
  const { boardSeq } = await tx.room.update({
    where: { id: roomId },
    data: { boardSeq: { increment: 1 } },
    select: { boardSeq: true },
  });
  return boardSeq;
}

async function writableRoom(slug: string, userId: string) {
  const { room, member } = await requireMember(slug, userId);
  if (room.endedAt) throw new HttpError('ROOM_ENDED', 'This meeting has ended.');
  return { room, member };
}

/**
 * The whole board as of one seq. Read in a single repeatable-read
 * transaction, so the rows and the seq describe the same moment: a client
 * applies this, then any live op with a higher seq.
 */
export async function getSnapshot(slug: string, userId: string): Promise<BoardSnapshot> {
  const { room } = await requireMember(slug, userId);
  return prisma.$transaction(
    async (tx) => {
      const { boardSeq } = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        select: { boardSeq: true },
      });
      const rows = await tx.whiteboardOp.findMany({
        where: { roomId: room.id },
        orderBy: { seq: 'asc' },
      });
      return { seq: boardSeq, elements: rows.map(toStored) };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Adds an element, or replaces one of the caller's own with the same id. */
export async function addElement(
  slug: string,
  userId: string,
  elementId: string,
  ciphertext: string,
): Promise<BoardOp> {
  const { room } = await writableRoom(slug, userId);
  const row = await prisma.$transaction(async (tx) => {
    const seq = await nextSeq(tx, room.id);
    const existing = await tx.whiteboardOp.findUnique({
      where: { roomId_elementId: { roomId: room.id, elementId } },
      select: { authorId: true },
    });
    if (existing) {
      if (existing.authorId !== userId) {
        throw new HttpError('FORBIDDEN', 'That element belongs to someone else.');
      }
      return tx.whiteboardOp.update({
        where: { roomId_elementId: { roomId: room.id, elementId } },
        data: { seq, payload: { ciphertext } },
      });
    }
    if ((await tx.whiteboardOp.count({ where: { roomId: room.id } })) >= MAX_BOARD_ELEMENTS) {
      throw new HttpError('CONFLICT', 'The whiteboard is full. Erase or clear something first.');
    }
    return tx.whiteboardOp.create({
      data: { roomId: room.id, authorId: userId, elementId, seq, payload: { ciphertext } },
    });
  });
  return { kind: 'add', seq: row.seq, element: toStored(row) };
}

/** Anyone in the room may erase: it is a shared board. */
export async function removeElements(
  slug: string,
  userId: string,
  elementIds: string[],
): Promise<BoardOp> {
  const { room } = await writableRoom(slug, userId);
  const ids = [...new Set(elementIds)];
  const seq = await prisma.$transaction(async (tx) => {
    const next = await nextSeq(tx, room.id);
    await tx.whiteboardOp.deleteMany({ where: { roomId: room.id, elementId: { in: ids } } });
    return next;
  });
  return { kind: 'remove', seq, ids };
}

/** Wiping everyone's work is the host's call. */
export async function clearBoard(slug: string, userId: string): Promise<BoardOp> {
  const { room, member } = await writableRoom(slug, userId);
  if (member.role !== 'OWNER' && member.role !== 'MODERATOR') {
    throw new HttpError('FORBIDDEN', 'Only the host can clear the whiteboard.');
  }
  const seq = await prisma.$transaction(async (tx) => {
    const next = await nextSeq(tx, room.id);
    await tx.whiteboardOp.deleteMany({ where: { roomId: room.id } });
    return next;
  });
  return { kind: 'clear', seq };
}
