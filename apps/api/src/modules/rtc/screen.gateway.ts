import { screenRequestSchema, SOCKET_EVENTS, type ScreenSharer } from '@confluence/shared';
import { HttpError } from '../../middleware/error-handler.js';
import { handle } from '../../realtime/ack.js';
import { roomChannel, type AppSocket, type AppSocketServer } from '../../realtime/types.js';
import { claimScreen, releaseScreen } from '../rooms/screen-lock.js';

/**
 * screen:claim / screen:release. The server is the only arbiter of who is
 * presenting; clients learn the outcome from the ack and from screen:state.
 * The media itself never changes hands here: the presenter swaps their own
 * outgoing video track (replaceTrack) once the claim succeeds.
 */
export function attachScreenGateway(io: AppSocketServer): void {
  io.on('connection', (socket: AppSocket) => {
    function requireSeat(slug: string): { userId: string; displayName: string } {
      const { userId, displayName, roomSlug } = socket.data;
      if (!userId || roomSlug !== slug)
        throw new HttpError('FORBIDDEN', 'You are not in this room.');
      return { userId, displayName: displayName ?? 'Someone' };
    }

    socket.on(
      SOCKET_EVENTS.SCREEN_CLAIM,
      handle(screenRequestSchema, async ({ slug }) => {
        const { userId, displayName } = requireSeat(slug);
        const request: ScreenSharer = {
          userId,
          peerId: socket.id,
          displayName,
          since: new Date().toISOString(),
        };
        const outcome = await claimScreen(slug, request);
        if (!outcome.ok) {
          throw new HttpError(
            'SCREEN_BUSY',
            `${outcome.holder.displayName} is already sharing their screen.`,
          );
        }
        io.to(roomChannel(slug)).emit(SOCKET_EVENTS.SCREEN_STATE, { slug, sharer: outcome.sharer });
        return outcome.sharer;
      }),
    );

    socket.on(
      SOCKET_EVENTS.SCREEN_RELEASE,
      handle(screenRequestSchema, async ({ slug }) => {
        requireSeat(slug);
        // Idempotent: releasing a lock you do not hold is not an error, it is
        // just nothing to do (the slot may already have been freed on leave).
        if (await releaseScreen(slug, socket.id)) {
          io.to(roomChannel(slug)).emit(SOCKET_EVENTS.SCREEN_STATE, { slug, sharer: null });
        }
        return null;
      }),
    );
  });
}
