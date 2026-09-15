import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  keyRequestsResponseSchema,
  roomKeyStateSchema,
  roomResponseSchema,
  userKeysSchema,
} from '@confluence/shared';
import * as e2e from '@confluence/crypto';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import {
  PASSWORD,
  errorOf,
  login,
  registerAndVerify,
  resetState,
  tokenFromLatestEmail,
} from '../../../test/helpers.js';
import {
  closeAllSockets,
  connectAs,
  joinRoom,
  nextEvent,
  noEvent,
  startServer,
  unwrap,
  type RunningServer,
} from '../../../test/sockets.js';

/**
 * Key distribution, driven the way the browser drives it: real key pairs,
 * real sealed boxes. The server must route and gate these blobs correctly
 * without ever being able to open one.
 */

interface Person {
  id: string;
  token: string;
  keys: e2e.KeyPair;
}

let server: RunningServer;
let host: Person;
let guest: Person;

const as = (p: Person) => ({ Authorization: `Bearer ${p.token}` });
const api = () => request(server.httpServer);

async function person(email: string, name: string): Promise<Person> {
  await registerAndVerify(server.httpServer, email, name);
  const { auth } = await login(server.httpServer, email);
  return { id: auth.user.id, token: auth.accessToken, keys: await e2e.generateKeyPair() };
}

/** What the client does on first sign-in: lock the private key, publish both. */
async function publishKeys(p: Person): Promise<void> {
  await api()
    .put('/me/keys')
    .set(as(p))
    .send({
      publicKey: await e2e.toBase64Url(p.keys.publicKey),
      encryptedPrivateKey: await e2e.toBase64Url(
        await e2e.lockPrivateKey(p.keys.privateKey, PASSWORD),
      ),
    })
    .expect(204);
}

async function createRoom(owner: Person): Promise<string> {
  const res = await api().post('/rooms').set(as(owner)).send({ name: 'Keys' }).expect(201);
  return roomResponseSchema.parse(res.body).room.slug;
}

/** Creates the room key as its first holder would, and returns it. */
async function initRoomKey(slug: string, p: Person): Promise<Uint8Array> {
  const roomKey = await e2e.generateRoomKey();
  await api()
    .put(`/rooms/${slug}/key`)
    .set(as(p))
    .send({
      keyCheck: await e2e.roomKeyCheck(roomKey),
      wrappedRoomKey: await e2e.toBase64Url(await e2e.sealTo(p.keys.publicKey, roomKey)),
    })
    .expect(204);
  return roomKey;
}

async function roomKeyOf(slug: string, p: Person) {
  const res = await api().get(`/rooms/${slug}/key`).set(as(p)).expect(200);
  return roomKeyStateSchema.parse(res.body);
}

/** Joining over the socket is what makes someone a member. */
async function joinAs(slug: string, p: Person) {
  const socket = await connectAs(server.url, p.token);
  unwrap(await joinRoom(socket, slug));
  return socket;
}

beforeAll(async () => {
  server = await startServer();
});

beforeEach(async () => {
  await resetState();
  host = await person('host@example.com', 'Host');
  guest = await person('guest@example.com', 'Guest');
});

afterEach(closeAllSockets);

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
  await redis.quit();
});

describe('user key pairs', () => {
  it('stores the public key and the locked private key, which only the password opens', async () => {
    const before = userKeysSchema.parse(
      (await api().get('/me/keys').set(as(host)).expect(200)).body,
    );
    expect(before).toEqual({ publicKey: null, encryptedPrivateKey: null });

    await publishKeys(host);
    const after = userKeysSchema.parse(
      (await api().get('/me/keys').set(as(host)).expect(200)).body,
    );
    expect(after.publicKey).toBe(await e2e.toBase64Url(host.keys.publicKey));

    const blob = await e2e.fromBase64Url(after.encryptedPrivateKey ?? '');
    expect(await e2e.unlockPrivateKey(blob, PASSWORD)).toEqual(host.keys.privateKey);
    await expect(e2e.unlockPrivateKey(blob, 'not the password')).rejects.toThrow(
      e2e.DecryptionError,
    );
  });

  it('can be set only once, so a stolen access token cannot swap in its own key', async () => {
    await publishKeys(host);
    const attacker = await e2e.generateKeyPair();
    const res = await api()
      .put('/me/keys')
      .set(as(host))
      .send({
        publicKey: await e2e.toBase64Url(attacker.publicKey),
        encryptedPrivateKey: await e2e.toBase64Url(new Uint8Array(100)),
      })
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });

  it('rejects malformed keys', async () => {
    await api()
      .put('/me/keys')
      .set(as(host))
      .send({ publicKey: 'short', encryptedPrivateKey: 'x' })
      .expect(422);
  });

  it('requires a signed-in user', async () => {
    await api().get('/me/keys').expect(401);
  });
});

describe('room keys', () => {
  it('the first holder creates the key; the second attempt loses', async () => {
    await publishKeys(host);
    const slug = await createRoom(host);
    expect(await roomKeyOf(slug, host)).toEqual({
      keyCheck: null,
      wrappedRoomKey: null,
      holders: 0,
    });

    const roomKey = await initRoomKey(slug, host);
    const state = await roomKeyOf(slug, host);
    expect(state.keyCheck).toBe(await e2e.roomKeyCheck(roomKey));
    const opened = await e2e.openSealed(
      host.keys,
      await e2e.fromBase64Url(state.wrappedRoomKey ?? ''),
    );
    expect(opened).toEqual(roomKey);

    const res = await api()
      .put(`/rooms/${slug}/key`)
      .set(as(host))
      .send({
        keyCheck: await e2e.roomKeyCheck(await e2e.generateRoomKey()),
        wrappedRoomKey: state.wrappedRoomKey,
      })
      .expect(409);
    expect(errorOf(res).code).toBe('CONFLICT');
  });

  it('two members racing to create it end up with exactly one key', async () => {
    await publishKeys(host);
    await publishKeys(guest);
    const slug = await createRoom(host);
    await joinAs(slug, guest);

    const attempt = async (p: Person) => {
      const key = await e2e.generateRoomKey();
      const res = await api()
        .put(`/rooms/${slug}/key`)
        .set(as(p))
        .send({
          keyCheck: await e2e.roomKeyCheck(key),
          wrappedRoomKey: await e2e.toBase64Url(await e2e.sealTo(p.keys.publicKey, key)),
        });
      return res.status;
    };
    const statuses = await Promise.all([attempt(host), attempt(guest)]);
    expect(statuses.sort()).toEqual([204, 409]);

    const held = await prisma.roomMember.count({
      where: { room: { slug }, wrappedRoomKey: { not: null } },
    });
    expect(held).toBe(1);
  });

  it('is only for members', async () => {
    const slug = await createRoom(host);
    const res = await api().get(`/rooms/${slug}/key`).set(as(guest)).expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
    await api().get('/rooms/doesnotexist/key').set(as(guest)).expect(404);
  });

  it('a newcomer is asked for, granted the key, and told so on their own socket', async () => {
    await publishKeys(host);
    await publishKeys(guest);
    const slug = await createRoom(host);
    const roomKey = await initRoomKey(slug, host);
    const hostSocket = await joinAs(slug, host);

    // The guest joining is what prompts the host's client to grant.
    const asked = nextEvent(hostSocket, 'room:key-requested', (p) => p.slug === slug);
    const guestSocket = await joinAs(slug, guest);
    await asked;

    const requests = keyRequestsResponseSchema.parse(
      (await api().get(`/rooms/${slug}/key/requests`).set(as(host)).expect(200)).body,
    ).requests;
    expect(requests).toEqual([
      {
        userId: guest.id,
        displayName: 'Guest',
        publicKey: await e2e.toBase64Url(guest.keys.publicKey),
      },
    ]);

    const granted = nextEvent(guestSocket, 'room:key-granted', (p) => p.slug === slug);
    const hostHears = noEvent(hostSocket, 'room:key-granted');
    const sealed = await e2e.sealTo(await e2e.fromBase64Url(requests[0]?.publicKey ?? ''), roomKey);
    await api()
      .post(`/rooms/${slug}/key/grants`)
      .set(as(host))
      .send({ userId: guest.id, wrappedRoomKey: await e2e.toBase64Url(sealed) })
      .expect(204);
    await granted;
    await hostHears;

    const state = await roomKeyOf(slug, guest);
    const opened = await e2e.openSealed(
      guest.keys,
      await e2e.fromBase64Url(state.wrappedRoomKey ?? ''),
    );
    expect(await e2e.roomKeyCheck(opened)).toBe(state.keyCheck);

    const after = keyRequestsResponseSchema.parse(
      (await api().get(`/rooms/${slug}/key/requests`).set(as(host)).expect(200)).body,
    );
    expect(after.requests).toEqual([]);
  });

  it('only a holder can grant, and a grant never replaces a key someone already has', async () => {
    await publishKeys(host);
    await publishKeys(guest);
    const slug = await createRoom(host);
    await joinAs(slug, guest);

    // The guest holds nothing yet, so cannot grant.
    await initRoomKey(slug, host);
    const res = await api()
      .post(`/rooms/${slug}/key/grants`)
      .set(as(guest))
      .send({ userId: host.id, wrappedRoomKey: await e2e.toBase64Url(new Uint8Array(80)) })
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');

    // A holder "granting" the host a second, different key changes nothing.
    const before = await roomKeyOf(slug, host);
    const bogus = await e2e.sealTo(host.keys.publicKey, await e2e.generateRoomKey());
    await api()
      .post(`/rooms/${slug}/key/grants`)
      .set(as(host))
      .send({ userId: host.id, wrappedRoomKey: await e2e.toBase64Url(bogus) })
      .expect(204);
    expect(await roomKeyOf(slug, host)).toEqual(before);
  });

  it('cannot grant to someone outside the room', async () => {
    await publishKeys(host);
    await publishKeys(guest);
    const slug = await createRoom(host);
    await initRoomKey(slug, host);
    await api()
      .post(`/rooms/${slug}/key/grants`)
      .set(as(host))
      .send({ userId: guest.id, wrappedRoomKey: await e2e.toBase64Url(new Uint8Array(80)) })
      .expect(404);
  });

  it('a member can drop an unusable key and ask for a fresh one', async () => {
    await publishKeys(host);
    const slug = await createRoom(host);
    await initRoomKey(slug, host);
    const guestSocket = await joinAs(slug, guest);

    const asked = nextEvent(guestSocket, 'room:key-requested', (p) => p.slug === slug);
    await api().delete(`/rooms/${slug}/key/mine`).set(as(host)).expect(204);
    await asked;
    expect((await roomKeyOf(slug, host)).wrappedRoomKey).toBeNull();
  });
});

describe('password reset', () => {
  it('clears the key pair and every room key sealed to it', async () => {
    await publishKeys(host);
    const slug = await createRoom(host);
    await initRoomKey(slug, host);

    await api().post('/auth/password/forgot').send({ email: 'host@example.com' }).expect(202);
    await api()
      .post('/auth/password/reset')
      .send({
        token: tokenFromLatestEmail('host@example.com', 'reset-password'),
        password: 'a brand new passphrase',
      })
      .expect(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: host.id } });
    expect(user.publicKey).toBeNull();
    expect(user.encryptedPrivateKey).toBeNull();
    const member = await prisma.roomMember.findFirstOrThrow({ where: { userId: host.id } });
    expect(member.wrappedRoomKey).toBeNull();
    // The room keeps its fingerprint: other holders still have the same key.
    const room = await prisma.room.findUniqueOrThrow({ where: { slug } });
    expect(room.keyCheck).not.toBeNull();
  });

  it('a room whose only key holder reset their password can be given a new key', async () => {
    await publishKeys(host);
    await publishKeys(guest);
    const slug = await createRoom(host);
    await joinAs(slug, guest);
    const oldKey = await initRoomKey(slug, host);

    // While someone holds the key, nobody may replace it.
    await api()
      .put(`/rooms/${slug}/key`)
      .set(as(guest))
      .send({
        keyCheck: await e2e.roomKeyCheck(await e2e.generateRoomKey()),
        wrappedRoomKey: await e2e.toBase64Url(new Uint8Array(80)),
      })
      .expect(409);

    await api().post('/auth/password/forgot').send({ email: 'host@example.com' }).expect(202);
    await api()
      .post('/auth/password/reset')
      .send({
        token: tokenFromLatestEmail('host@example.com', 'reset-password'),
        password: 'a brand new passphrase',
      })
      .expect(200);

    const lost = await roomKeyOf(slug, guest);
    expect(lost).toMatchObject({ keyCheck: await e2e.roomKeyCheck(oldKey), holders: 0 });

    const newKey = await initRoomKey(slug, guest);
    expect(await roomKeyOf(slug, guest)).toMatchObject({
      keyCheck: await e2e.roomKeyCheck(newKey),
      holders: 1,
    });
  });
});
