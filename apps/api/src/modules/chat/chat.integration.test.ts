import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ackSchema,
  chatHistoryResponseSchema,
  chatMessageSchema,
  memberKeysResponseSchema,
  roomResponseSchema,
} from '@confluence/shared';
import * as e2e from '@confluence/crypto';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { errorOf, login, registerAndVerify, resetState } from '../../../test/helpers.js';
import {
  closeAllSockets,
  connectAs,
  joinRoom,
  nextEvent,
  noEvent,
  startServer,
  unwrap,
  type RunningServer,
  type TestSocket,
} from '../../../test/sockets.js';

/**
 * Encrypted chat: storage, relay, history, and the binding that stops the
 * server from re-attributing or moving messages. Real client crypto.
 */

const sendAck = ackSchema(chatMessageSchema);

interface Person {
  id: string;
  token: string;
}

let server: RunningServer;
let host: Person;
let guest: Person;
let outsider: Person;
let slug: string;
let roomKey: Uint8Array;

const context = (senderId: string, id: string) => `confluence/chat/v1/${slug}/${senderId}/${id}`;
const api = () => request(server.httpServer);
const as = (p: Person) => ({ Authorization: `Bearer ${p.token}` });

async function seal(sender: Person, text: string, id: string = randomUUID()) {
  return {
    id,
    ciphertext: await e2e.encryptText(JSON.stringify({ text }), roomKey, context(sender.id, id)),
  };
}

async function send(socket: TestSocket, sender: Person, text: string, id?: string) {
  const sealed = await seal(sender, text, id);
  const raw: unknown = await socket.emitWithAck('chat:send', { slug, ...sealed });
  return sendAck.parse(raw);
}

async function seated(p: Person): Promise<TestSocket> {
  const socket = await connectAs(server.url, p.token);
  unwrap(await joinRoom(socket, slug));
  return socket;
}

async function historyOf(p: Person, before?: string) {
  const res = await api()
    .get(`/rooms/${slug}/messages`)
    .query(before ? { before } : {})
    .set(as(p))
    .expect(200);
  return chatHistoryResponseSchema.parse(res.body);
}

beforeAll(async () => {
  server = await startServer();
});

beforeEach(async () => {
  await resetState();
  const make = async (email: string, name: string): Promise<Person> => {
    await registerAndVerify(server.httpServer, email, name);
    const { auth } = await login(server.httpServer, email);
    return { id: auth.user.id, token: auth.accessToken };
  };
  host = await make('host@example.com', 'Host');
  guest = await make('guest@example.com', 'Guest');
  outsider = await make('outsider@example.com', 'Outsider');
  const res = await api().post('/rooms').set(as(host)).send({ name: 'Chat' }).expect(201);
  slug = roomResponseSchema.parse(res.body).room.slug;
  roomKey = await e2e.generateRoomKey();
});

afterEach(closeAllSockets);

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
  await redis.quit();
});

describe('chat', () => {
  it('delivers a message to the others, keeps it for history, and cannot read it', async () => {
    const hostSocket = await seated(host);
    const guestSocket = await seated(guest);

    const heard = nextEvent(guestSocket, 'chat:message');
    const echo = noEvent(hostSocket, 'chat:message');
    const sent = await send(hostSocket, host, 'The launch moves to Thursday.');
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.data.sender).toEqual({ userId: host.id, displayName: 'Host' });
    const { message } = await heard;
    await echo;
    expect(message).toEqual(sent.data);

    // Stored split into nonce and ciphertext, with no trace of the words.
    const row = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.nonce).toHaveLength(24);
    expect(Buffer.from(row.ciphertext).toString('latin1')).not.toContain('launch');

    const [stored] = (await historyOf(guest)).messages;
    if (!stored) throw new Error('missing');
    const text = await e2e.decryptText(
      stored.ciphertext,
      roomKey,
      context(stored.sender.userId, stored.id),
    );
    expect(JSON.parse(text)).toEqual({ text: 'The launch moves to Thursday.' });
  });

  it('binds each message to its sender: it cannot be passed off as someone else’s', async () => {
    const hostSocket = await seated(host);
    const sent = await send(hostSocket, host, 'I approve the budget.');
    if (!sent.ok) throw new Error('send failed');
    await expect(
      e2e.decryptText(sent.data.ciphertext, roomKey, context(guest.id, sent.data.id)),
    ).rejects.toBeInstanceOf(e2e.DecryptionError);
  });

  it('a retried send is not posted twice; someone else cannot reuse the id', async () => {
    const hostSocket = await seated(host);
    const guestSocket = await seated(guest);
    const id = randomUUID();
    const first = await send(hostSocket, host, 'once', id);
    const again = await send(hostSocket, host, 'once', id);
    expect(again).toEqual(first);
    expect(await prisma.message.count()).toBe(1);

    const stolen = await send(guestSocket, guest, 'mine now', id);
    expect(stolen).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('only people in the room can send or read', async () => {
    const outsiderSocket = await connectAs(server.url, outsider.token);
    const refused = await send(outsiderSocket, outsider, 'hello?');
    expect(refused).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const res = await api().get(`/rooms/${slug}/messages`).set(as(outsider)).expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('refuses anything that is not a sealed message', async () => {
    const hostSocket = await seated(host);
    const raw: unknown = await hostSocket.emitWithAck('chat:send', {
      slug,
      id: randomUUID(),
      ciphertext: 'c2hvcnQ',
    });
    expect(sendAck.parse(raw)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('pages history from newest to oldest', async () => {
    await seated(host);
    const room = await prisma.room.findUniqueOrThrow({ where: { slug } });
    const start = Date.now() - 60 * 60_000;
    await prisma.message.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        id: randomUUID(),
        roomId: room.id,
        senderId: host.id,
        nonce: new Uint8Array(24),
        ciphertext: new Uint8Array(20),
        createdAt: new Date(start + i * 1000),
      })),
    });
    const latest = await historyOf(host);
    expect(latest.messages).toHaveLength(50);
    expect(latest.hasMore).toBe(true);
    const times = latest.messages.map((m) => m.createdAt);
    expect([...times].sort()).toEqual(times);

    const older = await historyOf(host, latest.messages[0]?.id);
    expect(older.messages).toHaveLength(5);
    expect(older.hasMore).toBe(false);
    expect((older.messages.at(-1)?.createdAt ?? '') < (latest.messages[0]?.createdAt ?? '')).toBe(
      true,
    );
  });

  it('rate-limits a flood', async () => {
    const hostSocket = await seated(host);
    const results = [];
    for (let i = 0; i < 22; i++) results.push(await send(hostSocket, host, `spam ${i}`));
    expect(results.some((r) => !r.ok && r.error.code === 'RATE_LIMITED')).toBe(true);
  });
});

describe('member keys (safety codes)', () => {
  it('lists every member with their public key, to members only', async () => {
    await seated(guest);
    const res = await api().get(`/rooms/${slug}/members/keys`).set(as(host)).expect(200);
    const { members } = memberKeysResponseSchema.parse(res.body);
    expect(members.map((m) => m.displayName)).toEqual(['Host', 'Guest']);
    expect(members.every((m) => m.publicKey === null)).toBe(true);
    await api().get(`/rooms/${slug}/members/keys`).set(as(outsider)).expect(403);
  });
});
