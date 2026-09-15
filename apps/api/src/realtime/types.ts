import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '@confluence/shared';

export type AppSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

/** The Socket.IO room that carries a meeting's broadcasts. */
export const roomChannel = (slug: string): string => `room:${slug}`;

/** Every socket a user has open, on any instance. Joined at connection. */
export const userChannel = (userId: string): string => `user:${userId}`;
