import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createFileResponseSchema,
  fileDownloadResponseSchema,
  fileListResponseSchema,
  fileMetaPlaintextSchema,
  fileResponseSchema,
  roomResponseSchema,
  type CreateFileResponse,
} from '@confluence/shared';
import * as e2e from '@confluence/crypto';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { ensureBucket, objectSize, readObject } from '../../lib/storage.js';
import { errorOf, login, registerAndVerify, resetState } from '../../../test/helpers.js';
import {
  closeAllSockets,
  connectAs,
  joinRoom,
  nextEvent,
  startServer,
  unwrap,
  type RunningServer,
} from '../../../test/sockets.js';
import { purgeFiles } from './files.purge.js';

/**
 * Persisted files against real object storage (MinIO), encrypted with the
 * real client-side crypto. Besides the happy path, these prove the claim the
 * design rests on: nothing the server or the bucket holds is readable.
 */

const SECRET_TEXT = 'Q3 plan: acquire the competitor on the 14th. Tell nobody.';
const SECRET_NAME = 'q3-acquisition-plan.txt';

let server: RunningServer;
let hostToken: string;
let guestToken: string;
let slug: string;
let roomKey: Uint8Array;

const api = () => request(server.httpServer);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function signIn(email: string, name: string): Promise<string> {
  await registerAndVerify(server.httpServer, email, name);
  return (await login(server.httpServer, email)).auth.accessToken;
}

interface Prepared {
  ciphertext: Blob;
  body: {
    sizeBytes: number;
    encryptedName: string;
    encryptedKeyWrapped: string;
    checksum: string;
  };
}

/** Exactly what the browser does before it asks the API for anything. */
async function prepare(text = SECRET_TEXT, name = SECRET_NAME): Promise<Prepared> {
  const plain = new Blob([text], { type: 'text/plain' });
  const fileKey = await e2e.generateFileKey();
  const ciphertext = await e2e.encryptBlob(plain, fileKey);
  return {
    ciphertext,
    body: {
      sizeBytes: ciphertext.size,
      encryptedName: await e2e.encryptText(
        JSON.stringify({ name, type: plain.type, size: plain.size }),
        fileKey,
      ),
      encryptedKeyWrapped: await e2e.toBase64Url(await e2e.wrapKey(fileKey, roomKey)),
      checksum: await e2e.blobChecksum(ciphertext),
    },
  };
}

function putObject(created: CreateFileResponse, body: Blob): Promise<Response> {
  return fetch(created.uploadUrl, { method: 'PUT', headers: created.uploadHeaders, body });
}

async function share(token: string, prepared: Prepared): Promise<CreateFileResponse> {
  const res = await api()
    .post(`/rooms/${slug}/files`)
    .set(as(token))
    .send(prepared.body)
    .expect(201);
  const created = createFileResponseSchema.parse(res.body);
  expect((await putObject(created, prepared.ciphertext)).ok).toBe(true);
  await api().post(`/rooms/${slug}/files/${created.file.id}/complete`).set(as(token)).expect(200);
  return created;
}

beforeAll(async () => {
  server = await startServer();
  await ensureBucket();
});

beforeEach(async () => {
  await resetState();
  hostToken = await signIn('host@example.com', 'Host');
  guestToken = await signIn('guest@example.com', 'Guest');
  const res = await api().post('/rooms').set(as(hostToken)).send({ name: 'Files' }).expect(201);
  slug = roomResponseSchema.parse(res.body).room.slug;
  // Key distribution has its own tests; here the room key is simply known.
  roomKey = await e2e.generateRoomKey();
});

afterEach(closeAllSockets);

afterAll(async () => {
  await server.close();
  await prisma.$disconnect();
  await redis.quit();
});

describe('encrypted file sharing', () => {
  it('uploads straight to storage, announces the file, and round-trips it', async () => {
    const guestSocket = await connectAs(server.url, guestToken);
    unwrap(await joinRoom(guestSocket, slug));
    const prepared = await prepare();

    const res = await api()
      .post(`/rooms/${slug}/files`)
      .set(as(hostToken))
      .send(prepared.body)
      .expect(201);
    const created = createFileResponseSchema.parse(res.body);
    expect(new URL(created.uploadUrl).host).toBe('localhost:9000');

    // Pending uploads are invisible until completed.
    const pending = fileListResponseSchema.parse(
      (await api().get(`/rooms/${slug}/files`).set(as(guestToken)).expect(200)).body,
    );
    expect(pending.files).toEqual([]);

    expect((await putObject(created, prepared.ciphertext)).ok).toBe(true);
    const announced = nextEvent(guestSocket, 'file:shared', (p) => p.slug === slug);
    const done = await api()
      .post(`/rooms/${slug}/files/${created.file.id}/complete`)
      .set(as(hostToken))
      .expect(200);
    expect(fileResponseSchema.parse(done.body).file.id).toBe(created.file.id);
    expect((await announced).file).toMatchObject({
      id: created.file.id,
      uploader: { displayName: 'Host' },
    });

    // Another member lists it, downloads it from storage, and decrypts it.
    const [listed] = fileListResponseSchema.parse(
      (await api().get(`/rooms/${slug}/files`).set(as(guestToken)).expect(200)).body,
    ).files;
    if (!listed) throw new Error('file not listed');
    const link = fileDownloadResponseSchema.parse(
      (
        await api()
          .get(`/rooms/${slug}/files/${listed.id}/download`)
          .set(as(guestToken))
          .expect(200)
      ).body,
    );
    const download = await fetch(link.url);
    expect(download.headers.get('content-disposition')).toBe('attachment');
    const fetched = await download.blob();
    expect(await e2e.blobChecksum(fetched)).toBe(listed.checksum);

    const fileKey = await e2e.unwrapKey(
      await e2e.fromBase64Url(listed.encryptedKeyWrapped),
      roomKey,
    );
    const meta = fileMetaPlaintextSchema.parse(
      JSON.parse(await e2e.decryptText(listed.encryptedName, fileKey)),
    );
    expect(meta).toEqual({ name: SECRET_NAME, type: 'text/plain', size: SECRET_TEXT.length });
    const plain = await e2e.decryptBlob(fetched, fileKey, meta.type);
    expect(await plain.text()).toBe(SECRET_TEXT);
  });

  it('stores nothing readable: not the bytes, not the name, not the type', async () => {
    const created = await share(hostToken, await prepare());
    const row = await prisma.fileMeta.findUniqueOrThrow({ where: { id: created.file.id } });

    const stored = await readObject(row.storageKey);
    expect(stored.length).toBe(Number(row.sizeBytes));
    expect(decode(stored)).not.toContain('acquire');
    expect(decode(stored)).not.toContain('Q3 plan');

    const everyColumn = JSON.stringify(row, (_k, v: unknown) =>
      typeof v === 'bigint' ? Number(v) : v,
    );
    expect(everyColumn).not.toContain('q3-acquisition');
    expect(everyColumn).not.toContain('text/plain');
    expect(row.mimeType).toBe('application/octet-stream');
    // The storage key carries no hint of the original name either.
    expect(row.storageKey).toMatch(/^[a-z0-9]+\/[0-9a-f-]{36}$/);
  });

  it('refuses to complete an upload that never arrived', async () => {
    const prepared = await prepare();
    const res = await api()
      .post(`/rooms/${slug}/files`)
      .set(as(hostToken))
      .send(prepared.body)
      .expect(201);
    const { file } = createFileResponseSchema.parse(res.body);
    const early = await api()
      .post(`/rooms/${slug}/files/${file.id}/complete`)
      .set(as(hostToken))
      .expect(409);
    expect(errorOf(early).code).toBe('CONFLICT');
  });

  it('storage rejects an upload of a different size than was agreed', async () => {
    const prepared = await prepare();
    const res = await api()
      .post(`/rooms/${slug}/files`)
      .set(as(hostToken))
      .send(prepared.body)
      .expect(201);
    const created = createFileResponseSchema.parse(res.body);
    const bigger = new Blob([await prepared.ciphertext.arrayBuffer(), new Uint8Array(1024)]);
    expect((await putObject(created, bigger)).ok).toBe(false);
    const row = await prisma.fileMeta.findUniqueOrThrow({ where: { id: created.file.id } });
    expect(await objectSize(row.storageKey)).toBeNull();
  });

  it('only the uploader can complete their upload', async () => {
    const guestSocket = await connectAs(server.url, guestToken);
    unwrap(await joinRoom(guestSocket, slug));
    const prepared = await prepare();
    const res = await api()
      .post(`/rooms/${slug}/files`)
      .set(as(hostToken))
      .send(prepared.body)
      .expect(201);
    const created = createFileResponseSchema.parse(res.body);
    await putObject(created, prepared.ciphertext);
    await api()
      .post(`/rooms/${slug}/files/${created.file.id}/complete`)
      .set(as(guestToken))
      .expect(404);
  });

  it('is only for members of the room', async () => {
    const prepared = await prepare();
    const res = await api()
      .post(`/rooms/${slug}/files`)
      .set(as(guestToken))
      .send(prepared.body)
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
    await api().get(`/rooms/${slug}/files`).set(as(guestToken)).expect(403);
    await api().get(`/rooms/${slug}/files`).expect(401);
  });

  it('validates the request', async () => {
    const prepared = await prepare();
    await api()
      .post(`/rooms/${slug}/files`)
      .set(as(hostToken))
      .send({ ...prepared.body, sizeBytes: 200 * 1024 * 1024 })
      .expect(422);
    await api()
      .post(`/rooms/${slug}/files`)
      .set(as(hostToken))
      .send({ ...prepared.body, checksum: 'nope' })
      .expect(422);
    await api().get(`/rooms/${slug}/files/..%2F..%2Fetc/download`).set(as(hostToken)).expect(404);
  });

  it('no new files once the meeting has ended', async () => {
    await api().post(`/rooms/${slug}/end`).set(as(hostToken)).expect(204);
    const res = await api()
      .post(`/rooms/${slug}/files`)
      .set(as(hostToken))
      .send((await prepare()).body)
      .expect(410);
    expect(errorOf(res).code).toBe('ROOM_ENDED');
  });

  it('the host can delete anyone’s file; a guest only their own', async () => {
    const guestSocket = await connectAs(server.url, guestToken);
    unwrap(await joinRoom(guestSocket, slug));
    const hostFile = await share(hostToken, await prepare('host file'));
    const guestFile = await share(guestToken, await prepare('guest file'));

    const res = await api()
      .delete(`/rooms/${slug}/files/${hostFile.file.id}`)
      .set(as(guestToken))
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');

    const row = await prisma.fileMeta.findUniqueOrThrow({ where: { id: guestFile.file.id } });
    const gone = nextEvent(guestSocket, 'file:deleted', (p) => p.fileId === guestFile.file.id);
    await api().delete(`/rooms/${slug}/files/${guestFile.file.id}`).set(as(hostToken)).expect(204);
    await gone;
    expect(await objectSize(row.storageKey)).toBeNull();
    await api()
      .get(`/rooms/${slug}/files/${guestFile.file.id}/download`)
      .set(as(hostToken))
      .expect(404);
  });
});

describe('purge job', () => {
  it('removes expired files and abandoned uploads, object and row, and nothing else', async () => {
    const guestSocket = await connectAs(server.url, guestToken);
    unwrap(await joinRoom(guestSocket, slug));

    const keep = await share(hostToken, await prepare('keep me'));
    const expired = await share(hostToken, await prepare('old news'));
    const abandonedPrep = await prepare('never finished');
    const abandonedRes = await api()
      .post(`/rooms/${slug}/files`)
      .set(as(hostToken))
      .send(abandonedPrep.body)
      .expect(201);
    const abandoned = createFileResponseSchema.parse(abandonedRes.body);
    await putObject(abandoned, abandonedPrep.ciphertext);
    const freshPending = createFileResponseSchema.parse(
      (
        await api()
          .post(`/rooms/${slug}/files`)
          .set(as(hostToken))
          .send((await prepare()).body)
          .expect(201)
      ).body,
    );

    const hourAgo = new Date(Date.now() - 61 * 60 * 1000);
    await prisma.fileMeta.update({
      where: { id: expired.file.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.fileMeta.update({
      where: { id: abandoned.file.id },
      data: { createdAt: hourAgo },
    });
    const keys = Object.fromEntries(
      (await prisma.fileMeta.findMany()).map((f) => [f.id, f.storageKey] as const),
    );

    const announced = nextEvent(guestSocket, 'file:deleted', (p) => p.fileId === expired.file.id);
    expect(await purgeFiles()).toEqual({ expired: 1, abandoned: 1 });
    await announced;

    const left = (await prisma.fileMeta.findMany()).map((f) => f.id).sort();
    expect(left).toEqual([keep.file.id, freshPending.file.id].sort());
    expect(await objectSize(keys[expired.file.id] ?? '')).toBeNull();
    expect(await objectSize(keys[abandoned.file.id] ?? '')).toBeNull();
    expect(await objectSize(keys[keep.file.id] ?? '')).not.toBeNull();
  });
});
