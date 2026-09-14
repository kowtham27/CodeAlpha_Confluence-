import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketAuthError,
  SocketData,
} from '@confluence/shared';
import { env } from './config/env.js';
import { authEvents } from './lib/auth-events.js';
import { logger } from './lib/logger.js';
import { isSessionRevoked } from './modules/auth/session.service.js';
import { verifyAccessToken } from './modules/auth/tokens.js';
import { createApp } from './app.js';

export type AppSocketServer = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface AppServer {
  httpServer: HttpServer;
  io: AppSocketServer;
}

const sessionRoom = (sessionId: string): string => `session:${sessionId}`;
const userRoom = (userId: string): string => `user:${userId}`;

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

export function createAppServer(): AppServer {
  const app = createApp();
  const httpServer = createServer(app);

  const io: AppSocketServer = new SocketServer(httpServer, {
    cors: { origin: [env.WEB_ORIGIN], credentials: true },
    // Spec section 7: cap payloads so a single message cannot exhaust memory.
    maxHttpBufferSize: 1_000_000,
    pingTimeout: 20_000,
    pingInterval: 25_000,
  });

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
    void socket.join([userRoom(userId), sessionRoom(sessionId)]);
    logger.debug({ socketId: socket.id, userId }, 'socket connected');

    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  // Logout, logout-everywhere, and reuse detection all end here: every socket
  // opened under a revoked session is closed immediately.
  const onSessionsRevoked = ({ sessionIds }: { userId: string; sessionIds: string[] }): void => {
    for (const id of sessionIds) io.in(sessionRoom(id)).disconnectSockets(true);
  };
  authEvents.on('sessions-revoked', onSessionsRevoked);
  httpServer.on('close', () => authEvents.off('sessions-revoked', onSessionsRevoked));

  return { httpServer, io };
}
