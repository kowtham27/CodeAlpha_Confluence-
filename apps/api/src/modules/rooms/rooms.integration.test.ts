import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { roomListResponseSchema, roomResponseSchema } from '@confluence/shared';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { errorOf, login, registerAndVerify, resetState } from '../../../test/helpers.js';

const app = createApp();

async function user(email: string, name: string): Promise<string> {
  await registerAndVerify(app, email, name);
  return (await login(app, email)).auth.accessToken;
}

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createRoom(token: string, name = 'Standup') {
  const res = await request(app).post('/rooms').set(as(token)).send({ name }).expect(201);
  return roomResponseSchema.parse(res.body).room;
}

let host: string;
let guest: string;

beforeEach(async () => {
  await resetState();
  host = await user('host@example.com', 'Host');
  guest = await user('guest@example.com', 'Guest');
});

afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});

describe('rooms REST', () => {
  it('creates a room owned by the creator, with an unguessable slug', async () => {
    const room = await createRoom(host, 'Design review');
    expect(room).toMatchObject({
      name: 'Design review',
      myRole: 'OWNER',
      isLocked: false,
      endedAt: null,
      maxParticipants: 6,
      participantCount: 0,
      owner: { displayName: 'Host' },
    });
    expect(room.slug).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const second = await createRoom(host);
    expect(second.slug).not.toBe(room.slug);
  });

  it('requires a signed-in user', async () => {
    await request(app).post('/rooms').send({ name: 'x' }).expect(401);
    await request(app).get('/rooms').expect(401);
  });

  it('validates the name and the slug', async () => {
    const res = await request(app).post('/rooms').set(as(host)).send({ name: '   ' }).expect(422);
    expect(errorOf(res).details?.['name']).toBeDefined();
    await request(app).get('/rooms/not%20a%20slug').set(as(host)).expect(422);
    await request(app).get('/rooms/AAAAAAAAAAAA').set(as(host)).expect(404);
  });

  it('lets anyone with the link look a room up, without a role', async () => {
    const room = await createRoom(host);
    const res = await request(app).get(`/rooms/${room.slug}`).set(as(guest)).expect(200);
    expect(roomResponseSchema.parse(res.body).room).toMatchObject({
      slug: room.slug,
      myRole: null,
    });
  });

  it('lists only rooms the user owns or has joined', async () => {
    await createRoom(host, 'Mine');
    await createRoom(guest, 'Theirs');
    const res = await request(app).get('/rooms').set(as(host)).expect(200);
    const names = roomListResponseSchema.parse(res.body).rooms.map((r) => r.name);
    expect(names).toEqual(['Mine']);
  });

  it('only the host can lock or rename a room', async () => {
    const room = await createRoom(host);
    const denied = await request(app)
      .patch(`/rooms/${room.slug}`)
      .set(as(guest))
      .send({ isLocked: true })
      .expect(403);
    expect(errorOf(denied).code).toBe('FORBIDDEN');

    const res = await request(app)
      .patch(`/rooms/${room.slug}`)
      .set(as(host))
      .send({ isLocked: true, name: 'Locked standup' })
      .expect(200);
    expect(roomResponseSchema.parse(res.body).room).toMatchObject({
      isLocked: true,
      name: 'Locked standup',
    });
  });

  it('rejects an empty update', async () => {
    const room = await createRoom(host);
    await request(app).patch(`/rooms/${room.slug}`).set(as(host)).send({}).expect(422);
  });

  it('only the host can end a meeting, and ending is idempotent', async () => {
    const room = await createRoom(host);
    await request(app).post(`/rooms/${room.slug}/end`).set(as(guest)).expect(403);
    await request(app).post(`/rooms/${room.slug}/end`).set(as(host)).expect(204);
    await request(app).post(`/rooms/${room.slug}/end`).set(as(host)).expect(204);

    const res = await request(app).get(`/rooms/${room.slug}`).set(as(host)).expect(200);
    expect(roomResponseSchema.parse(res.body).room.endedAt).not.toBeNull();

    const locked = await request(app)
      .patch(`/rooms/${room.slug}`)
      .set(as(host))
      .send({ isLocked: true })
      .expect(410);
    expect(errorOf(locked).code).toBe('ROOM_ENDED');
  });
});
