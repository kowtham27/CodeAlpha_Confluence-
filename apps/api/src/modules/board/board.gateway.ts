import {
  boardAddRequestSchema,
  boardClearRequestSchema,
  boardCursorRequestSchema,
  boardDraftRequestSchema,
  boardRemoveRequestSchema,
  SOCKET_EVENTS,
  type BoardAck,
  type BoardOp,
} from '@confluence/shared';
import { HttpError } from '../../middleware/error-handler.js';
import { handle } from '../../realtime/ack.js';
import { BOARD_BUDGET, BOARD_LIVE_BUDGET, TokenBucket } from '../../realtime/socket-limiter.js';
import { roomChannel, type AppSocket, type AppSocketServer } from '../../realtime/types.js';
import * as board from './board.service.js';

/**
 * Whiteboard events. Committed changes (add, remove, clear) are stored, acked
 * with their seq, and broadcast to the rest of the room in server order.
 * Drafts and cursors are relayed and forgotten: they are sent volatile, so a
 * slow client drops stale frames instead of queueing them.
 *
 * Only a socket seated in the room may do either. Payloads are ciphertext:
 * the server checks shape and size, never content.
 */
export function attachBoardGateway(io: AppSocketServer): void {
  io.on('connection', (socket: AppSocket) => {
    const changes = new TokenBucket(BOARD_BUDGET.capacity, BOARD_BUDGET.refillPerSecond);
    const live = new TokenBucket(BOARD_LIVE_BUDGET.capacity, BOARD_LIVE_BUDGET.refillPerSecond);

    function requireSeat(slug: string): string {
      const { userId, roomSlug } = socket.data;
      if (!userId || roomSlug !== slug) {
        throw new HttpError('FORBIDDEN', 'You are not in this room.');
      }
      if (!changes.take()) throw new HttpError('RATE_LIMITED', 'Slow down a little.');
      return userId;
    }

    const commit = (slug: string, op: BoardOp): BoardAck => {
      socket.to(roomChannel(slug)).emit(SOCKET_EVENTS.BOARD_OP, { slug, op });
      return { seq: op.seq };
    };

    socket.on(
      SOCKET_EVENTS.BOARD_ADD,
      handle(boardAddRequestSchema, async ({ slug, id, ciphertext }) =>
        commit(slug, await board.addElement(slug, requireSeat(slug), id, ciphertext)),
      ),
    );

    socket.on(
      SOCKET_EVENTS.BOARD_REMOVE,
      handle(boardRemoveRequestSchema, async ({ slug, ids }) =>
        commit(slug, await board.removeElements(slug, requireSeat(slug), ids)),
      ),
    );

    socket.on(
      SOCKET_EVENTS.BOARD_CLEAR,
      handle(boardClearRequestSchema, async ({ slug }) =>
        commit(slug, await board.clearBoard(slug, requireSeat(slug))),
      ),
    );

    // Relays: no ack, and anything invalid or over budget is silently dropped.
    const relayable = (slug: string): boolean => socket.data.roomSlug === slug && live.take();

    socket.on(SOCKET_EVENTS.BOARD_DRAFT, (raw: unknown) => {
      const parsed = boardDraftRequestSchema.safeParse(raw);
      if (!parsed.success || !relayable(parsed.data.slug)) return;
      const { slug, id, ciphertext } = parsed.data;
      socket
        .to(roomChannel(slug))
        .volatile.emit(SOCKET_EVENTS.BOARD_DRAFT, { slug, from: socket.id, id, ciphertext });
    });

    socket.on(SOCKET_EVENTS.BOARD_CURSOR, (raw: unknown) => {
      const parsed = boardCursorRequestSchema.safeParse(raw);
      if (!parsed.success || !relayable(parsed.data.slug)) return;
      const { slug, ciphertext } = parsed.data;
      socket
        .to(roomChannel(slug))
        .volatile.emit(SOCKET_EVENTS.BOARD_CURSOR, { slug, from: socket.id, ciphertext });
    });
  });
}
