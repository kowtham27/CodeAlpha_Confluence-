import { createServer, type Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as SocketServer } from 'socket.io';
import type { SocketAuthError } from '@confluence/shared';
import { env } from './config/env.js';
import { authEvents } from './lib/auth-events.js';
import { logger } from './lib/logger.js';
import { createAdapterClients } from './lib/redis.js';
import { isSessionRevoked } from './modules/auth/session.service.js';
import { verifyAccessToken } from './modules/auth/tokens.js';
import { attachRoomGateway } from './modules/rooms/room.gateway.js';
import { attachScreenGateway } from './modules/rtc/screen.gateway.js';
import { attachBoardGateway } from './modules/board/board.gateway.js';
import { attachChatGateway } from './modules/chat/chat.gateway.js';
import { attachSignalingGateway } from './modules/rtc/signaling.gateway.js';
import { DEFAULT_TIMING, type PresenceTiming } from './modules/rooms/presence.js';
import { userChannel, type AppSocket, type AppSocketServer } from './realtime/types.js';
import { createApp } from './app.js';

export type { AppSocketServer } from './realtime/types.js';

export interface AppServer {
  httpServer: HttpServer;
  io: AppSocketServer;
  /**
   * Orderly stop: disconnect every socket, wait for their presence cleanup
   * (which broadcasts through the Redis adapter), then close the adapter's
   * connections. Closing them first strands those broadcasts as unhandled
   * "Connection is closed" rejections. Idempotent.
   */
  shutdown: () => Promise<void>;
}

export interface AppServerOptions {
  /** Tests shorten these to exercise timeouts without waiting 30s. */
  presence?: Partial<PresenceTiming> & { sweepMs?: number };
}

const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

function authError(code: SocketAuthError): Error {
  return new Error(code);
}

/**
 * Spec: reject unauthenticated connections in io.use(), before any event
 * handler runs. The token is checked once, at handshake. A socket outliving
 * its 15-minute access token is fine; a revoked session is not, which is why
 * revocation actively disconnects sockets (below) instead of relying on expiry.
 */
async function authenticateSocket(socket: AppSocket): Promise<void> {
  const token: unknown = (socket.handshake.auth as Record<string, unknown>)['token'];
  if (typeof token !== 'string' || token.length === 0) throw authError('UNAUTHENTICATED');

  const result = await verifyAccessToken(token);
  if (!result.ok) {
    throw authError(result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED');
  }
  if (await isSessionRevoked(result.claims.sessionId)) throw authError('UNAUTHENTICATED');

  socket.data.userId = result.claims.userId;
  socket.data.sessionId = result.claims.sessionId;
}

export function createAppServer(options: AppServerOptions = {}): AppServer {
  const app = createApp();
  const httpServer = createServer(app);

  const io: AppSocketServer = new SocketServer(httpServer, {
    cors: { origin: [env.WEB_ORIGIN], credentials: true },
    // Spec section 7: cap payloads so a single message cannot exhaust memory.
    maxHttpBufferSize: 1_000_000,
    pingTimeout: 20_000,
    pingInterval: 25_000,
  });

  // Redis adapter: broadcasts and room membership span every API instance, so
  // two people in one meeting may be connected to different servers. The key
  // is namespaced by environment because Redis pub/sub ignores the DB number:
  // without it, the test suite and a running dev server would hear each other.
  const { pubClient, subClient } = createAdapterClients();
  io.adapter(createAdapter(pubClient, subClient, { key: `confluence:${env.NODE_ENV}:socket.io` }));

  io.use((socket, next) => {
    authenticateSocket(socket)
      .then(() => next())
      .catch((error: unknown) => {
        next(error instanceof Error ? error : authError('UNAUTHENTICATED'));
      });
  });

  io.on('connection', (socket) => {
    const { userId, sessionId } = socket.data;
    if (!userId || !sessionId) {
      // Unreachable while io.use() above is in place; fail closed if it ever isn't.
      socket.disconnect(true);
      return;
    }
    void socket.join([userChannel(userId), sessionRoom(sessionId)]);
    logger.debug({ socketId: socket.id, userId }, 'socket connected');

    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  attachSignalingGateway(io);
  attachScreenGateway(io);
  attachBoardGateway(io);
  attachChatGateway(io);

  const stopRooms = attachRoomGateway(io, {
    timing: { ...DEFAULT_TIMING, ...options.presence },
    sweepMs: options.presence?.sweepMs ?? 15_000,
  });

  // Logout, logout-everywhere, reuse detection and password resets all end
  // here: every socket opened under a revoked session is closed immediately,
  // which also takes it out of any meeting.
  const onSessionsRevoked = ({ sessionIds }: { userId: string; sessionIds: string[] }): void => {
    for (const id of sessionIds) io.in(sessionRoom(id)).disconnectSockets(true);
  };
  authEvents.on('sessions-revoked', onSessionsRevoked);

  let closing: Promise<void> | null = null;
  const shutdown = (): Promise<void> =>
    (closing ??= (async () => {
      authEvents.off('sessions-revoked', onSessionsRevoked);
      await io.close(); // also closes httpServer
      await stopRooms();
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    })());

  return { httpServer, io, shutdown };
}
