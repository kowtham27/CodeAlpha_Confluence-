import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { roomResponseSchema, type Participant } from '@confluence/shared';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { WEB_ORIGIN, login, registerAndVerify, resetState } from '../../../test/helpers.js';
import {
  closeAllSockets,
  connectAs,
  joinRoom,
  leaveRoom,
  nextEvent,
  noEvent,
  startServer,
  unwrap,
  type RunningServer,
} from '../../../test/sockets.js';
import { joinPresence } from './presence.js';

// Short, but with room for a slow CI box: a live socket heartbeats 7 times
// inside one stale window.
const TIMING = { heartbeatMs: 200, staleMs: 1_500, sweepMs: 300 };

let server: RunningServer;
let host: string;
let guest: string;
let third: string;

beforeAll(async () => {
  server = await startServer({ presence: TIMING });
});

beforeEach(async () => {
  await resetState();
  const make = async (email: string, name: string) => {
    await registerAndVerify(server.httpServer, email, name);
    return (await login(server.httpServer, email)).auth.accessToken;
  };
  [host, guest, third] = [
    await make('host@example.com', 'Host'),
    await make('guest@example.com', 'Guest'),
    await make('third@example.com', 'Third'),
  ];
});

afterEach(closeAllSockets);

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
  await redis.quit();
});

async function createRoom(token: string): Promise<string> {
  const res = await request(server.httpServer)
    .post('/rooms')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Standup' })
    .expect(201);
  return roomResponseSchema.parse(res.body).room.slug;
}

const names = (list: Participant[]) => list.map((p) => p.displayName).sort();

describe('joining and leaving', () => {
  it('spec deliverable: two people join the same room and see each other', async () => {
    const slug = await createRoom(host);
    const a = await connectAs(server.url, host);
    const b = await connectAs(server.url, guest);

    const aSnapshot = nextEvent(a, 'room:participants');
    const aJoin = unwrap(await joinRoom(a, slug));
    expect(aJoin.self).toMatchObject({ displayName: 'Host', role: 'OWNER', peerId: a.id });
    expect(names((await aSnapshot).participants)).toEqual(['Host']);

    const aSeesB = nextEvent(a, 'room:peer-joined');
    const bSnapshot = nextEvent(b, 'room:participants');
    const bJoin = unwrap(await joinRoom(b, slug));
    expect(bJoin.self).toMatchObject({ displayName: 'Guest', role: 'GUEST' });
    expect(bJoin.room.participantCount).toBe(2);

    expect((await aSeesB).participant).toMatchObject({ displayName: 'Guest', peerId: b.id });
    expect(names((await bSnapshot).participants)).toEqual(['Guest', 'Host']);
  });

  it('announces a deliberate leave and a dropped connection differently', async () => {
    const slug = await createRoom(host);
    const a = await connectAs(server.url, host);
    const b = await connectAs(server.url, guest);
    const c = await connectAs(server.url, third);
    for (const s of [a, b, c]) unwrap(await joinRoom(s, slug));

    const left = nextEvent(a, 'room:peer-left', (e) => e.peerId === b.id);
    unwrap(await leaveRoom(b, slug));
    expect(await left).toMatchObject({ reason: 'left' });

    // Capture the id first: socket.io-client clears socket.id on disconnect.
    const cId = c.id;
    const dropped = nextEvent(a, 'room:peer-left', (e) => e.peerId === cId);
    c.disconnect();
    expect(await dropped).toMatchObject({ reason: 'disconnected' });
  });

  it('counts live participants in the room summary', async () => {
    const slug = await createRoom(host);
    unwrap(await joinRoom(await connectAs(server.url, host), slug));
    unwrap(await joinRoom(await connectAs(server.url, guest), slug));

    const res = await request(server.httpServer)
      .get(`/rooms/${slug}`)
      .set('Authorization', `Bearer ${third}`)
      .expect(200);
    expect(roomResponseSchema.parse(res.body).room.participantCount).toBe(2);
  });

  it('records membership, so the room appears in the guest room list', async () => {
    const slug = await createRoom(host);
    unwrap(await joinRoom(await connectAs(server.url, guest), slug));
    const res = await request(server.httpServer)
      .get('/rooms')
      .set('Authorization', `Bearer ${guest}`)
      .expect(200);
    expect(JSON.stringify(res.body)).toContain(slug);
  });
});

describe('admission rules (server-side, never trusted to the client)', () => {
  it('refuses a room that does not exist, or a malformed slug', async () => {
    const a = await connectAs(server.url, host);
    const missing = await joinRoom(a, 'AAAAAAAAAAAA');
    expect(missing).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const malformed = await joinRoom(a, '../../etc');
    expect(malformed).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('keeps newcomers out of a locked room, but lets members back in', async () => {
    const slug = await createRoom(host);
    const a = await connectAs(server.url, host);
    const b = await connectAs(server.url, guest);
    unwrap(await joinRoom(a, slug));
    unwrap(await joinRoom(b, slug));
    unwrap(await leaveRoom(b, slug));

    const updated = nextEvent(a, 'room:updated');
    await request(server.httpServer)
      .patch(`/rooms/${slug}`)
      .set('Authorization', `Bearer ${host}`)
      .send({ isLocked: true })
      .expect(200);
    expect(await updated).toMatchObject({ slug, isLocked: true });

    const c = await connectAs(server.url, third);
    expect(await joinRoom(c, slug)).toMatchObject({ ok: false, error: { code: 'ROOM_LOCKED' } });
    // The guest already belongs to the meeting: a dropped connection must not lock them out.
    unwrap(await joinRoom(b, slug));
  });

  it('refuses a full room', async () => {
    const slug = await createRoom(host);
    await prisma.room.update({ where: { slug }, data: { maxParticipants: 2 } });
    unwrap(await joinRoom(await connectAs(server.url, host), slug));
    unwrap(await joinRoom(await connectAs(server.url, guest), slug));

    const full = await joinRoom(await connectAs(server.url, third), slug);
    expect(full).toMatchObject({ ok: false, error: { code: 'ROOM_FULL' } });
  });

  it('never over-admits when people race for the last seat', async () => {
    const slug = await createRoom(host);
    await prisma.room.update({ where: { slug }, data: { maxParticipants: 2 } });
    const sockets = await Promise.all(
      [host, guest, third].map((token) => connectAs(server.url, token)),
    );

    const results = await Promise.all(sockets.map((s) => joinRoom(s, slug)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.error.code === 'ROOM_FULL')).toHaveLength(1);
  });

  it('ends a meeting for everyone in it, and refuses later joins', async () => {
    const slug = await createRoom(host);
    const a = await connectAs(server.url, host);
    const b = await connectAs(server.url, guest);
    unwrap(await joinRoom(a, slug));
    unwrap(await joinRoom(b, slug));

    const ended = nextEvent(b, 'room:ended');
    await request(server.httpServer)
      .post(`/rooms/${slug}/end`)
      .set('Authorization', `Bearer ${host}`)
      .expect(204);
    expect(await ended).toEqual({ slug });

    expect(await joinRoom(b, slug)).toMatchObject({ ok: false, error: { code: 'ROOM_ENDED' } });
  });

  it('only lets a socket leave the room it is actually in', async () => {
    const slug = await createRoom(host);
    const other = await createRoom(host);
    const a = await connectAs(server.url, host);
    unwrap(await joinRoom(a, slug));
    expect(await leaveRoom(a, other)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('refuses a socket with no token at the handshake', async () => {
    await expect(connectAs(server.url, '')).rejects.toThrow('UNAUTHENTICATED');
  });
});

describe('one seat per person', () => {
  it('a second tab takes over; the first is told, the room sees a swap, not a newcomer', async () => {
    const slug = await createRoom(host);
    const watcher = await connectAs(server.url, guest);
    unwrap(await joinRoom(watcher, slug));

    const tab1 = await connectAs(server.url, host);
    unwrap(await joinRoom(tab1, slug));

    const tab2 = await connectAs(server.url, host);
    const displaced = nextEvent(tab1, 'room:displaced');
    const swappedOut = nextEvent(watcher, 'room:peer-left', (e) => e.peerId === tab1.id);
    const swappedIn = nextEvent(
      watcher,
      'room:peer-joined',
      (e) => e.participant.peerId === tab2.id,
    );
    const joined = unwrap(await joinRoom(tab2, slug));

    expect(await displaced).toEqual({ slug });
    expect(await swappedOut).toMatchObject({ reason: 'displaced' });
    await swappedIn;
    expect(joined.room.participantCount).toBe(2);

    // The displaced tab closing afterwards must not remove the new tab's seat.
    const noLeave = noEvent(watcher, 'room:peer-left', 800);
    tab1.disconnect();
    await noLeave;
  });
});

describe('presence survives crashes and revocations', () => {
  it('keeps live participants through many stale windows (heartbeats work)', async () => {
    const slug = await createRoom(host);
    const a = await connectAs(server.url, host);
    const b = await connectAs(server.url, guest);
    unwrap(await joinRoom(a, slug));
    unwrap(await joinRoom(b, slug));
    await noEvent(a, 'room:peer-left', TIMING.staleMs * 2.5);
  });

  it('sweeps a participant whose server died, and tells the room', async () => {
    const slug = await createRoom(host);
    const a = await connectAs(server.url, host);
    unwrap(await joinRoom(a, slug));

    // A participant from an instance that crashed: its entry exists, but
    // nothing will ever refresh it.
    const ghost: Participant = {
      peerId: 'ghost-socket',
      userId: 'ghost-user',
      displayName: 'Ghost',
      role: 'GUEST',
      joinedAt: new Date().toISOString(),
    };
    await joinPresence(slug, ghost, 6, TIMING);

    const swept = await nextEvent(a, 'room:peer-left', (e) => e.userId === 'ghost-user', 6_000);
    expect(swept).toMatchObject({ peerId: 'ghost-socket', reason: 'timeout' });
  });

  it('removes someone whose session is revoked', async () => {
    const slug = await createRoom(host);
    const a = await connectAs(server.url, host);
    const b = await connectAs(server.url, guest);
    unwrap(await joinRoom(a, slug));
    unwrap(await joinRoom(b, slug));

    const bId = b.id; // cleared by socket.io-client once the server disconnects it
    const gone = nextEvent(a, 'room:peer-left', (e) => e.peerId === bId);
    await request(server.httpServer)
      .post('/auth/logout-all')
      .set('Origin', WEB_ORIGIN)
      .set('Authorization', `Bearer ${guest}`)
      .expect(204);
    expect(await gone).toMatchObject({ reason: 'disconnected' });
  });
});

describe('horizontal scaling (Redis adapter)', () => {
  it('people connected to different API instances share one room', async () => {
    const second = await startServer({ presence: TIMING });
    try {
      const slug = await createRoom(host);
      const onFirst = await connectAs(server.url, host);
      const onSecond = await connectAs(second.url, guest);

      unwrap(await joinRoom(onFirst, slug));
      const crossJoin = nextEvent(onFirst, 'room:peer-joined');
      const snapshot = nextEvent(onSecond, 'room:participants');
      unwrap(await joinRoom(onSecond, slug));

      expect((await crossJoin).participant.displayName).toBe('Guest');
      expect(names((await snapshot).participants)).toEqual(['Guest', 'Host']);

      const crossLeave = nextEvent(onFirst, 'room:peer-left');
      onSecond.disconnect();
      expect(await crossLeave).toMatchObject({ reason: 'disconnected' });
    } finally {
      await second.close();
    }
  });
});
