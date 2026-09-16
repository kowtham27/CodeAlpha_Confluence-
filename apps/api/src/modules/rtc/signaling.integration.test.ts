import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { roomResponseSchema } from '@confluence/shared';
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

let server: RunningServer;
let tokens: { a: string; b: string; c: string };

const SESSION = 'test-session-1';
const OFFER = { type: 'offer' as const, sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
const ANSWER = { type: 'answer' as const, sdp: 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n' };
const CANDIDATE = {
  candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
};

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
    a: await make('a@example.com', 'Ada'),
    b: await make('b@example.com', 'Ben'),
    c: await make('c@example.com', 'Cy'),
  };
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
    .send({ name: 'Call' })
    .expect(201);
  return roomResponseSchema.parse(res.body).room.slug;
}

/** Three people in one room. */
async function trio(): Promise<{ slug: string; a: TestSocket; b: TestSocket; c: TestSocket }> {
  const slug = await createRoom(tokens.a);
  const a = await connectAs(server.url, tokens.a);
  const b = await connectAs(server.url, tokens.b);
  const c = await connectAs(server.url, tokens.c);
  for (const s of [a, b, c]) unwrap(await joinRoom(s, slug));
  return { slug, a, b, c };
}

describe('signaling relay', () => {
  it('delivers an offer to the addressee only, stamped with the real sender', async () => {
    const { a, b, c } = await trio();

    const received = nextEvent(b, 'webrtc:offer');
    const bystander = noEvent(c, 'webrtc:offer', 700);
    const echo = noEvent(a, 'webrtc:offer', 700);
    unwrap(
      await a.emitWithAck('webrtc:offer', { to: b.id ?? '', session: SESSION, description: OFFER }),
    );

    expect(await received).toEqual({ from: a.id, session: SESSION, description: OFFER });
    await bystander; // spec: SDP is never broadcast
    await echo;
  });

  it('relays answers and ICE candidates, including end-of-candidates', async () => {
    const { a, b } = await trio();

    const answer = nextEvent(a, 'webrtc:answer');
    unwrap(
      await b.emitWithAck('webrtc:answer', {
        to: a.id ?? '',
        session: SESSION,
        description: ANSWER,
      }),
    );
    expect(await answer).toEqual({ from: b.id, session: SESSION, description: ANSWER });

    const ice = nextEvent(a, 'webrtc:ice-candidate', (e) => e.candidate !== null);
    unwrap(
      await b.emitWithAck('webrtc:ice-candidate', {
        to: a.id ?? '',
        session: SESSION,
        candidate: CANDIDATE,
      }),
    );
    expect(await ice).toEqual({ from: b.id, session: SESSION, candidate: CANDIDATE });

    const done = nextEvent(a, 'webrtc:ice-candidate', (e) => e.candidate === null);
    unwrap(
      await b.emitWithAck('webrtc:ice-candidate', {
        to: a.id ?? '',
        session: SESSION,
        candidate: null,
      }),
    );
    expect(await done).toEqual({ from: b.id, session: SESSION, candidate: null });
  });

  it('refuses to reach someone in a different room', async () => {
    const { a } = await trio();
    const otherRoom = await createRoom(tokens.a);
    const stranger = await connectAs(server.url, tokens.c);
    // Cy's first socket is in the trio's room; this one sits in another room.
    await stranger.emitWithAck('room:join', { slug: otherRoom });

    const nothing = noEvent(stranger, 'webrtc:offer', 700);
    const result = await a.emitWithAck('webrtc:offer', {
      to: stranger.id ?? '',
      session: SESSION,
      description: OFFER,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    await nothing;
  });

  it('refuses signaling from a socket that is not in a room', async () => {
    const { b } = await trio();
    const outsider = await connectAs(server.url, tokens.c);
    const result = await outsider.emitWithAck('webrtc:offer', {
      to: b.id ?? '',
      session: SESSION,
      description: OFFER,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('refuses mislabelled, self-addressed, and oversized messages', async () => {
    const { a, b } = await trio();
    const wrongType = await a.emitWithAck('webrtc:offer', {
      to: b.id ?? '',
      session: SESSION,
      description: ANSWER,
    });
    expect(wrongType).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });

    const toSelf = await a.emitWithAck('webrtc:offer', {
      to: a.id ?? '',
      session: SESSION,
      description: OFFER,
    });
    expect(toSelf).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    const huge = await a.emitWithAck('webrtc:offer', {
      to: b.id ?? '',
      session: SESSION,
      description: { type: 'offer', sdp: 'x'.repeat(70_000) },
    });
    expect(huge).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('rate-limits a socket that floods the relay', async () => {
    const { a, b } = await trio();
    const results = await Promise.all(
      Array.from({ length: 360 }, () =>
        a.emitWithAck('webrtc:ice-candidate', {
          to: b.id ?? '',
          session: SESSION,
          candidate: CANDIDATE,
        }),
      ),
    );
    const limited = results.filter((r) => !r.ok && r.error.code === 'RATE_LIMITED');
    expect(limited.length).toBeGreaterThan(0);
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(300);
  });

  it('relays between people connected to different API instances', async () => {
    const second = await startServer();
    try {
      const slug = await createRoom(tokens.a);
      const a = await connectAs(server.url, tokens.a);
      const b = await connectAs(second.url, tokens.b);
      unwrap(await joinRoom(a, slug));
      unwrap(await joinRoom(b, slug));

      const received = nextEvent(b, 'webrtc:offer');
      unwrap(
        await a.emitWithAck('webrtc:offer', {
          to: b.id ?? '',
          session: SESSION,
          description: OFFER,
        }),
      );
      expect(await received).toEqual({ from: a.id, session: SESSION, description: OFFER });
    } finally {
      await second.close();
    }
  });
});

describe('media state', () => {
  it('broadcasts mic/camera changes to the others, and keeps them for late joiners', async () => {
    const slug = await createRoom(tokens.a);
    const a = await connectAs(server.url, tokens.a);
    const b = await connectAs(server.url, tokens.b);
    unwrap(await a.emitWithAck('room:join', { slug, media: { audio: true, video: true } }));
    unwrap(await joinRoom(b, slug));

    const seen = nextEvent(b, 'room:peer-media');
    const notEchoed = noEvent(a, 'room:peer-media', 700);
    unwrap(await a.emitWithAck('media:state', { slug, audio: false, video: true }));
    expect(await seen).toMatchObject({ peerId: a.id, media: { audio: false, video: true } });
    await notEchoed;

    const c = await connectAs(server.url, tokens.c);
    const snapshot = nextEvent(c, 'room:participants');
    unwrap(await joinRoom(c, slug));
    const ada = (await snapshot).participants.find((p) => p.displayName === 'Ada');
    expect(ada?.media).toEqual({ audio: false, video: true });
  });

  it('only accepts media state for the room the socket is in', async () => {
    const { a } = await trio();
    const other = await createRoom(tokens.a);
    const result = await a.emitWithAck('media:state', { slug: other, audio: true, video: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});

describe('ICE servers at join', () => {
  it('hands each joiner STUN plus TURN credentials minted for them', async () => {
    const slug = await createRoom(tokens.a);
    const a = await connectAs(server.url, tokens.a);
    const joined = unwrap(await joinRoom(a, slug));
    const turn = joined.iceServers.find((s) => s.username);
    // Whether the relay is coturn or a hosted service, `urls` is one string
    // or a list of them; joining always hands the browser a STUN server and
    // credentialled TURN.
    const urls = [joined.iceServers[0]?.urls ?? []].flat();
    expect(urls.some((url) => url.startsWith('stun:'))).toBe(true);
    expect(turn?.username).toBeTruthy();
    expect(turn?.credential).toBeTruthy();
  });
});
