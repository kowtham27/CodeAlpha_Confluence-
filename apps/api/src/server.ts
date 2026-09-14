import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '@confluence/shared';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';

export type AppSocketServer = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface AppServer {
  httpServer: HttpServer;
  io: AppSocketServer;
}

/**
 * Wires Express and Socket.IO onto one HTTP server so both share a port and
 * the same CORS policy. Phase 1 adds handshake auth in io.use(); Phase 2 adds
 * the Redis adapter and the room handlers. Today it accepts connections and
 * registers nothing, which is enough to prove the wiring.
 */
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

  io.on('connection', (socket) => {
    logger.debug({ socketId: socket.id }, 'socket connected');
    socket.on('disconnect', (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  return { httpServer, io };
}
