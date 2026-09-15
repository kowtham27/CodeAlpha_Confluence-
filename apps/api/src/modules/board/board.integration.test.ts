import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  MAX_BOARD_ELEMENTS,
  ackSchema,
  boardAckSchema,
  boardSnapshotSchema,
  roomResponseSchema,
  type BoardAck,
} from '@confluence/shared';
import * as e2e from '@confluence/crypto';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { login, registerAndVerify, resetState } from '../../../test/helpers.js';
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
 * The whiteboard's server side: ordering, compaction, permissions, relays.
 * Elements are encrypted with the real client crypto, so the test also shows
 * the server storing and serving ciphertext it cannot read.
 */

const boardAck = ackSchema(boardAckSchema);

let server: RunningServer;
let tokens: { host: string; guest: string; outsider: string };
let slug: string;
let roomKey: Uint8Array;

const context = (id: string) => `confluence/board/v1/element/${slug}/${id}`;

async function sealed(element: object, id: string): Promise<string> {
  return e2e.encryptText(JSON.stringify(element), roomKey, context(id));
}

const RECT = { type: 'rect', color: '#dc2626', width: 4, x1: 10, y1: 10, x2: 200, y2: 120 };

async function add(socket: TestSocket, id = randomUUID(), element: object = RECT) {
  const raw: unknown = await socket.emitWithAck('board:add', {
    slug,
    id,
    ciphertext: await sealed(element, id),
  });
  return { id, result: boardAck.parse(raw) };
}

const seqOf = (result: { ok: true; data: BoardAck } | { ok: false }): number => {
  if (!result.ok) throw new Error('expected success');
  return result.data.seq;
};

async function snapshot(token: string) {
  const res = await request(server.httpServer)
    .get(`/rooms/${slug}/board`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return boardSnapshotSchema.parse(res.body);
}

async function seated(token: string): Promise<TestSocket> {
  const socket = await connectAs(server.url, token);
  unwrap(await joinRoom(socket, slug));
  return socket;
}

beforeAll(async () => {
  server = await startServer();
});

beforeEach(async () => {
  await resetState();
  const make = async (email: string, name: string) => {
    await registerAndVerify(server.httpServer, email, name);
    return (await login(server.httpServer, email)).auth.accessToken;
  };
  tokens = {
    host: await make('host@example.com', 'Host'),
    guest: await make('guest@example.com', 'Guest'),
    outsider: await make('outsider@example.com', 'Outsider'),
  };
  const res = await request(server.httpServer)
    .post('/rooms')
    .set('Authorization', `Bearer ${tokens.host}`)
    .send({ name: 'Sketch' })
    .expect(201);
  slug = roomResponseSchema.parse(res.body).room.slug;
  roomKey = await e2e.generateRoomKey();
});

afterEach(closeAllSockets);

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
  await redis.quit();
});

describe('committed changes', () => {
  it('acks each change with the next seq and sends it to everyone else, in order', async () => {
    const host = await seated(tokens.host);
    const guest = await seated(tokens.guest);

    const heard = nextEvent(guest, 'board:op', (p) => p.op.kind === 'add');
    const hostHearsOwn = noEvent(host, 'board:op');
    const first = await add(host);
    expect(seqOf(first.result)).toBe(1);
    const { op } = await heard;
    await hostHearsOwn;
    expect(op).toMatchObject({ kind: 'add', seq: 1, element: { id: first.id, seq: 1 } });

    const second = await add(guest);
    expect(seqOf(second.result)).toBe(2);

    const removed = nextEvent(host, 'board:op', (p) => p.op.kind === 'remove');
    const raw: unknown = await guest.emitWithAck('board:remove', { slug, ids: [first.id] });
    expect(seqOf(boardAck.parse(raw))).toBe(3);
    expect((await removed).op).toEqual({ kind: 'remove', seq: 3, ids: [first.id] });

    // The snapshot is exactly what is left, as of the latest seq.
    const snap = await snapshot(tokens.guest);
    expect(snap.seq).toBe(3);
    expect(snap.elements.map((e) => e.id)).toEqual([second.id]);
  });

  it('stores ciphertext the server cannot read, which members decrypt', async () => {
    const host = await seated(tokens.host);
    const secret = {
      type: 'text',
      color: '#1f2937',
      size: 24,
      x: 40,
      y: 60,
      text: 'Launch date: 3 March',
    };
    const { id } = await add(host, randomUUID(), secret);

    const row = await prisma.whiteboardOp.findFirstOrThrow({ where: { elementId: id } });
    const stored = JSON.stringify(row);
    for (const leak of ['Launch', '"type"', '"text"', '#1f2937']) {
      expect(stored).not.toContain(leak);
    }

    const [element] = (await snapshot(tokens.host)).elements;
    if (!element) throw new Error('missing');
    expect(JSON.parse(await e2e.decryptText(element.ciphertext, roomKey, context(id)))).toEqual(
      secret,
    );
    // Bound to its id: the server cannot pass it off as a different element.
    await expect(
      e2e.decryptText(element.ciphertext, roomKey, context(randomUUID())),
    ).rejects.toBeInstanceOf(e2e.DecryptionError);
  });

  it('re-adding an id replaces your own element, but never someone else’s', async () => {
    const host = await seated(tokens.host);
    const guest = await seated(tokens.guest);
    const { id } = await add(host);
    const moved = await add(host, id, { ...RECT, x1: 300 });
    expect(seqOf(moved.result)).toBe(2);
    expect(await prisma.whiteboardOp.count()).toBe(1);

    const stolen = await add(guest, id);
    expect(stolen.result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    // A refused change consumes no seq: the order has no holes.
    expect(seqOf((await add(guest)).result)).toBe(3);
  });

  it('erasing and clearing delete rows: the board compacts itself', async () => {
    const host = await seated(tokens.host);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await add(host)).id);
    await host.emitWithAck('board:remove', { slug, ids: ids.slice(0, 2) });
    expect(await prisma.whiteboardOp.count()).toBe(3);

    const raw: unknown = await host.emitWithAck('board:clear', { slug });
    expect(seqOf(boardAck.parse(raw))).toBe(7);
    expect(await prisma.whiteboardOp.count()).toBe(0);
    expect(await snapshot(tokens.host)).toEqual({ seq: 7, elements: [] });
  });

  it('only the host can clear the board', async () => {
    await seated(tokens.host);
    const guest = await seated(tokens.guest);
    await add(guest);
    const raw: unknown = await guest.emitWithAck('board:clear', { slug });
    expect(boardAck.parse(raw)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await prisma.whiteboardOp.count()).toBe(1);
  });

  it('refuses sockets that are not seated in the room', async () => {
    const outsider = await connectAs(server.url, tokens.outsider);
    const id = randomUUID();
    const raw: unknown = await outsider.emitWithAck('board:add', {
      slug,
      id,
      ciphertext: await sealed(RECT, id),
    });
    expect(boardAck.parse(raw)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await request(server.httpServer)
      .get(`/rooms/${slug}/board`)
      .set('Authorization', `Bearer ${tokens.outsider}`)
      .expect(403);
  });

  it('validates the payload', async () => {
    const host = await seated(tokens.host);
    const raw: unknown = await host.emitWithAck('board:add', {
      slug,
      id: 'not-a-uuid',
      ciphertext: 'has spaces',
    });
    expect(boardAck.parse(raw)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('caps the number of live elements', async () => {
    const host = await seated(tokens.host);
    const room = await prisma.room.findUniqueOrThrow({ where: { slug } });
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'host@example.com' } });
    await prisma.whiteboardOp.createMany({
      data: Array.from({ length: MAX_BOARD_ELEMENTS }, (_, i) => ({
        roomId: room.id,
        authorId: user.id,
        elementId: randomUUID(),
        seq: i + 1,
        payload: { ciphertext: 'x' },
      })),
    });
    await prisma.room.update({ where: { id: room.id }, data: { boardSeq: MAX_BOARD_ELEMENTS } });
    const full = await add(host);
    expect(full.result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
});

describe('live relays', () => {
  it('relays drafts and cursors to the others, stamped with the sender, never stored', async () => {
    const host = await seated(tokens.host);
    const guest = await seated(tokens.guest);
    const id = randomUUID();

    const draft = nextEvent(guest, 'board:draft');
    const hostHearsOwn = noEvent(host, 'board:draft');
    host.emit('board:draft', { slug, id, ciphertext: await sealed(RECT, id) });
    expect(await draft).toMatchObject({ slug, from: host.id, id });
    await hostHearsOwn;

    const cursor = nextEvent(guest, 'board:cursor');
    host.emit('board:cursor', { slug, ciphertext: null });
    expect(await cursor).toEqual({ slug, from: host.id, ciphertext: null });

    expect(await prisma.whiteboardOp.count()).toBe(0);
  });

  it('drops relays from outside the room and malformed ones', async () => {
    const guest = await seated(tokens.guest);
    const outsider = await connectAs(server.url, tokens.outsider);
    const silent = noEvent(guest, 'board:draft', 800);
    outsider.emit('board:draft', { slug, id: randomUUID(), ciphertext: 'abc' });
    outsider.emit('board:draft', { slug, id: 'nope', ciphertext: 'abc' });
    await silent;
  });
});
