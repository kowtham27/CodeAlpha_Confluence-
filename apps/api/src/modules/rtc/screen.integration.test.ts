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
  startServer,
  unwrap,
  type RunningServer,
  type TestSocket,
} from '../../../test/sockets.js';
import { claimScreen } from '../rooms/screen-lock.js';

const TIMING = { heartbeatMs: 200, staleMs: 1_500, sweepMs: 300 };

let server: RunningServer;
let tokens: { a: string; b: string; c: string };

beforeAll(async () => {
  server = await startServer({ presence: TIMING });
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

async function room(): Promise<{ slug: string; a: TestSocket; b: TestSocket }> {
  const res = await request(server.httpServer)
    .post('/rooms')
    .set('Authorization', `Bearer ${tokens.a}`)
    .send({ name: 'Demo' })
    .expect(201);
  const slug = roomResponseSchema.parse(res.body).room.slug;
  const a = await connectAs(server.url, tokens.a);
  const b = await connectAs(server.url, tokens.b);
  unwrap(await joinRoom(a, slug));
  unwrap(await joinRoom(b, slug));
  return { slug, a, b };
}

const claim = (s: TestSocket, slug: string) => s.emitWithAck('screen:claim', { slug });
const release = (s: TestSocket, slug: string) => s.emitWithAck('screen:release', { slug });

describe('screen share slot', () => {
  it('lets one person present and tells everyone, including the presenter', async () => {
    const { slug, a, b } = await room();
    const bSees = nextEvent(b, 'screen:state');
    const aSees = nextEvent(a, 'screen:state');

    const sharer = unwrap(await claim(a, slug));
    expect(sharer).toMatchObject({ displayName: 'Ada', peerId: a.id });
    expect((await bSees).sharer?.displayName).toBe('Ada');
    expect((await aSees).sharer?.peerId).toBe(a.id);
  });

  it('refuses a second presenter with a message naming the first', async () => {
    const { slug, a, b } = await room();
    unwrap(await claim(a, slug));
    expect(await claim(b, slug)).toMatchObject({
      ok: false,
      error: { code: 'SCREEN_BUSY', message: 'Ada is already sharing their screen.' },
    });
  });

  it('never grants two claims that race', async () => {
    const { slug, a, b } = await room();
    const results = await Promise.all([claim(a, slug), claim(b, slug)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('frees the slot on release, so someone else can present', async () => {
    const { slug, a, b } = await room();
    unwrap(await claim(a, slug));
    const cleared = nextEvent(b, 'screen:state', (e) => e.sharer === null);
    unwrap(await release(a, slug));
    await cleared;
    unwrap(await claim(b, slug));
  });

  it('ignores a release from someone who is not presenting', async () => {
    const { slug, a, b } = await room();
    unwrap(await claim(a, slug));
    unwrap(await release(b, slug));
    expect(await claim(b, slug)).toMatchObject({ ok: false, error: { code: 'SCREEN_BUSY' } });
  });

  it('frees the slot when the presenter disconnects', async () => {
    const { slug, a, b } = await room();
    unwrap(await claim(a, slug));
    const cleared = nextEvent(b, 'screen:state', (e) => e.sharer === null);
    a.disconnect();
    await cleared;
    unwrap(await claim(b, slug));
  });

  it('frees the slot when the presenter takes over from another tab', async () => {
    const { slug, a, b } = await room();
    unwrap(await claim(a, slug));
    const cleared = nextEvent(b, 'screen:state', (e) => e.sharer === null);
    const secondTab = await connectAs(server.url, tokens.a);
    unwrap(await joinRoom(secondTab, slug));
    await cleared;
  });

  it('takes over a lock whose holder vanished without cleanup (crashed server)', async () => {
    const { slug, b } = await room();
    // A lock held by someone with no seat: what a crashed instance leaves behind.
    await claimScreen(slug, {
      userId: 'ghost',
      peerId: 'ghost-socket',
      displayName: 'Ghost',
      since: new Date().toISOString(),
    });
    unwrap(await claim(b, slug));
  });

  it('shows a late joiner who is presenting', async () => {
    const { slug, a } = await room();
    unwrap(await claim(a, slug));
    const c = await connectAs(server.url, tokens.c);
    const joined = unwrap(await joinRoom(c, slug));
    expect(joined.screen?.displayName).toBe('Ada');
  });

  it('only lets people in the room claim it', async () => {
    const { slug } = await room();
    const outsider = await connectAs(server.url, tokens.c);
    expect(await claim(outsider, slug)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('clears the slot when the meeting ends', async () => {
    const { slug, a } = await room();
    unwrap(await claim(a, slug));
    await request(server.httpServer)
      .post(`/rooms/${slug}/end`)
      .set('Authorization', `Bearer ${tokens.a}`)
      .expect(204);
    expect(await redis.exists(`screen:${slug}`)).toBe(0);
  });
});
