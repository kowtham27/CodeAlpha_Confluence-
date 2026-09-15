import { chatSendRequestSchema, SOCKET_EVENTS } from '@confluence/shared';
import { HttpError } from '../../middleware/error-handler.js';
import { handle } from '../../realtime/ack.js';
import { CHAT_BUDGET, TokenBucket } from '../../realtime/socket-limiter.js';
import { roomChannel, type AppSocket, type AppSocketServer } from '../../realtime/types.js';
import { sendMessage } from './chat.service.js';

/**
 * chat:send. The sender must be seated in the room. The stored message is
 * acked to the sender and broadcast to everyone else, with the sender
 * identity the server authenticated, never one taken from the payload.
 */
export function attachChatGateway(io: AppSocketServer): void {
  io.on('connection', (socket: AppSocket) => {
    const bucket = new TokenBucket(CHAT_BUDGET.capacity, CHAT_BUDGET.refillPerSecond);

    socket.on(
      SOCKET_EVENTS.CHAT_SEND,
      handle(chatSendRequestSchema, async ({ slug, id, ciphertext }) => {
        const { userId, roomSlug } = socket.data;
        if (!userId || roomSlug !== slug) {
          throw new HttpError('FORBIDDEN', 'You are not in this room.');
        }
        if (!bucket.take()) throw new HttpError('RATE_LIMITED', 'Slow down a little.');
        const message = await sendMessage(slug, userId, id, ciphertext);
        socket.to(roomChannel(slug)).emit(SOCKET_EVENTS.CHAT_MESSAGE, { slug, message });
        return message;
      }),
    );
  });
}
