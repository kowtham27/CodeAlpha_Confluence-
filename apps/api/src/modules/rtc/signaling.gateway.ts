import {
  mediaStateRequestSchema,
  signalDescriptionRequestSchema,
  signalIceRequestSchema,
  SOCKET_EVENTS,
} from '@confluence/shared';
import { HttpError } from '../../middleware/error-handler.js';
import { handle } from '../../realtime/ack.js';
import { SIGNALING_BUDGET, TokenBucket } from '../../realtime/socket-limiter.js';
import { roomChannel, type AppSocket, type AppSocketServer } from '../../realtime/types.js';
import * as presence from '../rooms/presence.js';

/**
 * WebRTC signaling relay. The server never interprets SDP or ICE: it checks
 * that the message is allowed and forwards it to exactly one socket.
 *
 * Allowed means: the sender is in a room, the addressee holds a seat in that
 * same room, and the sender is within its rate budget. Everything else is
 * refused, so a socket cannot use the relay to reach a stranger in another
 * meeting, or to spray SDP at a room. Spec: never broadcast SDP.
 *
 * `from` is always the sender's real socket id, stamped here. A client-
 * supplied `from` would let one peer impersonate another.
 */
export function attachSignalingGateway(io: AppSocketServer): void {
  io.on('connection', (socket: AppSocket) => {
    const bucket = new TokenBucket(SIGNALING_BUDGET.capacity, SIGNALING_BUDGET.refillPerSecond);

    async function authorizeRelay(to: string): Promise<void> {
      if (!bucket.take()) throw new HttpError('RATE_LIMITED', 'Too many signaling messages.');
      const slug = socket.data.roomSlug;
      if (!slug) throw new HttpError('FORBIDDEN', 'Join a room before signaling.');
      if (to === socket.id) throw new HttpError('FORBIDDEN', 'Cannot signal yourself.');
      if (!(await presence.findPeer(slug, to))) {
        throw new HttpError('NOT_FOUND', 'That participant is not in this room.');
      }
    }

    socket.on(
      SOCKET_EVENTS.WEBRTC_OFFER,
      handle(signalDescriptionRequestSchema, async ({ to, session, description }) => {
        if (description.type !== 'offer')
          throw new HttpError('VALIDATION_FAILED', 'Expected an offer.');
        await authorizeRelay(to);
        io.to(to).emit(SOCKET_EVENTS.WEBRTC_OFFER, { from: socket.id, session, description });
        return null;
      }),
    );

    socket.on(
      SOCKET_EVENTS.WEBRTC_ANSWER,
      handle(signalDescriptionRequestSchema, async ({ to, session, description }) => {
        if (description.type !== 'answer')
          throw new HttpError('VALIDATION_FAILED', 'Expected an answer.');
        await authorizeRelay(to);
        io.to(to).emit(SOCKET_EVENTS.WEBRTC_ANSWER, { from: socket.id, session, description });
        return null;
      }),
    );

    socket.on(
      SOCKET_EVENTS.WEBRTC_ICE_CANDIDATE,
      handle(signalIceRequestSchema, async ({ to, session, candidate }) => {
        await authorizeRelay(to);
        io.to(to).emit(SOCKET_EVENTS.WEBRTC_ICE_CANDIDATE, { from: socket.id, session, candidate });
        return null;
      }),
    );

    socket.on(
      SOCKET_EVENTS.MEDIA_STATE,
      handle(mediaStateRequestSchema, async ({ slug, audio, video }) => {
        const { userId } = socket.data;
        if (!userId || socket.data.roomSlug !== slug) {
          throw new HttpError('FORBIDDEN', 'You are not in this room.');
        }
        const updated = await presence.setMedia(slug, userId, socket.id, { audio, video });
        if (!updated) throw new HttpError('FORBIDDEN', 'Your seat in this room has moved.');
        socket.to(roomChannel(slug)).emit(SOCKET_EVENTS.ROOM_PEER_MEDIA, {
          slug,
          userId,
          peerId: socket.id,
          media: updated.media,
        });
        return null;
      }),
    );
  });
}
