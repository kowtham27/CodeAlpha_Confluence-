import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { createAppServer, type AppServer } from './server.js';
import { WEB_ORIGIN, login, registerAndVerify, resetState } from '../test/helpers.js';

let server: AppServer;
let url: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = createAppServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});

beforeEach(resetState);

afterAll(async () => {
  for (const s of sockets) s.close();
  await server.io.close();
  await prisma.$disconnect();
  await redis.quit();
});

function open(token?: string): Socket {
  const socket = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    ...(token ? { auth: { token } } : {}),
  });
  sockets.push(socket);
  return socket;
}

/** Resolves 'connected', or the connect_error message (e.g. UNAUTHENTICATED). */
function outcome(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.once('connect', () => resolve('connected'));
    socket.once('connect_error', (error) => resolve(error.message));
  });
}

describe('socket handshake auth', () => {
  it('rejects a connection with no token', async () => {
    expect(await outcome(open())).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged token', async () => {
    expect(await outcome(open('eyJhbGciOiJIUzI1NiJ9.e30.forged'))).toBe('UNAUTHENTICATED');
  });

  it('accepts a valid access token', async () => {
    await registerAndVerify(server.httpServer);
    const { auth } = await login(server.httpServer);
    expect(await outcome(open(auth.accessToken))).toBe('connected');
  });

  it('disconnects open sockets when the user logs out everywhere', async () => {
    await registerAndVerify(server.httpServer);
    const { auth } = await login(server.httpServer);
    const socket = open(auth.accessToken);
    expect(await outcome(socket)).toBe('connected');

    const dropped = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    await request(server.httpServer)
      .post('/auth/logout-all')
      .set('Origin', WEB_ORIGIN)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(204);

    // "io server disconnect" means the server closed it on purpose.
    expect(await dropped).toBe('io server disconnect');

    // And the same token cannot reconnect.
    expect(await outcome(open(auth.accessToken))).toBe('UNAUTHENTICATED');
  });
});
