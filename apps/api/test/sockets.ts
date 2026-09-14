import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  Ack,
  ClientToServerEvents,
  RoomJoinResult,
  ServerToClientEvents,
} from '@confluence/shared';
import { createAppServer, type AppServer, type AppServerOptions } from '../src/server.js';

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface RunningServer extends AppServer {
  url: string;
  close: () => Promise<void>;
}

/** Starts a real server on an ephemeral port. */
export async function startServer(options: AppServerOptions = {}): Promise<RunningServer> {
  const server = createAppServer(options);
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address() as AddressInfo;
  return {
    ...server,
    url: `http://127.0.0.1:${port}`,
    close: () => server.shutdown(),
  };
}

const open: TestSocket[] = [];

/** Connects and waits for the handshake; rejects with the connect_error message. */
export async function connectAs(url: string, token: string): Promise<TestSocket> {
  const socket: TestSocket = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    auth: { token },
    forceNew: true,
  });
  open.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
  });
  return socket;
}

export function closeAllSockets(): void {
  for (const s of open.splice(0)) s.close();
}

export function joinRoom(socket: TestSocket, slug: string): Promise<Ack<RoomJoinResult>> {
  return socket.emitWithAck('room:join', { slug });
}

export function leaveRoom(socket: TestSocket, slug: string): Promise<Ack<null>> {
  return socket.emitWithAck('room:leave', { slug });
}

type EventName = keyof ServerToClientEvents;
type EventPayload<E extends EventName> = Parameters<ServerToClientEvents[E]>[0];

/**
 * Resolves with the next `event` matching `predicate`. Register it BEFORE
 * triggering the action, or a fast server can deliver the event first.
 */
export function nextEvent<E extends EventName>(
  socket: TestSocket,
  event: E,
  predicate: (payload: EventPayload<E>) => boolean = () => true,
  timeoutMs = 8_000,
): Promise<EventPayload<E>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener as never);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (payload: EventPayload<E>): void => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener as never);
      resolve(payload);
    };
    socket.on(event, listener as never);
  });
}

/** Asserts `event` does NOT arrive within `ms`. */
export function noEvent(socket: TestSocket, event: EventName, ms = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const listener = (): void => {
      clearTimeout(timer);
      reject(new Error(`unexpected ${event}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, listener);
      resolve();
    }, ms);
    socket.on(event, listener);
  });
}

export function unwrap<T>(result: Ack<T>): T {
  if (!result.ok) throw new Error(`ack failed: ${result.error.code} ${result.error.message}`);
  return result.data;
}
