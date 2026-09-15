import { randomUUID } from 'node:crypto';
import {
  FILE_RETENTION_DAYS,
  type CreateFileRequest,
  type CreateFileResponse,
  type FileSummary,
} from '@confluence/shared';
import type { FileMeta } from '../../generated/prisma/client.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { roomEvents } from '../../lib/room-events.js';
import { deleteObject, objectSize, presignDownload, presignUpload } from '../../lib/storage.js';
import { HttpError } from '../../middleware/error-handler.js';
import { fromBase64Url, requireMember, toBase64Url } from '../rooms/membership.js';

/**
 * Persisted, end-to-end encrypted files (spec Phase 5b).
 *
 * The API handles metadata and permissions only. The browser encrypts the
 * file, uploads ciphertext straight to object storage with a presigned URL,
 * and tells the API when it is done; the API then checks the object really
 * exists at the agreed size before announcing it. File bytes never pass
 * through this process, and nothing stored here or in the bucket is
 * readable: the name, type and content are all encrypted with a per-file key
 * that is itself wrapped with the room key.
 */

type FileWithUploader = FileMeta & { uploader: { id: string; displayName: string } };

const withUploader = { uploader: { select: { id: true, displayName: true } } } as const;

export function toFileSummary(file: FileWithUploader): FileSummary {
  return {
    id: file.id,
    encryptedName: file.filename,
    encryptedKeyWrapped: toBase64Url(file.encryptedKeyWrapped),
    sizeBytes: Number(file.sizeBytes),
    checksum: file.checksum,
    uploader: { userId: file.uploader.id, displayName: file.uploader.displayName },
    createdAt: file.createdAt.toISOString(),
    expiresAt: file.expiresAt.toISOString(),
  };
}

export async function createFile(
  slug: string,
  userId: string,
  body: CreateFileRequest,
): Promise<CreateFileResponse> {
  const { room } = await requireMember(slug, userId);
  if (room.endedAt)
    throw new HttpError('ROOM_ENDED', 'This meeting has ended; files can no longer be added.');

  const file = await prisma.fileMeta.create({
    data: {
      roomId: room.id,
      uploaderId: userId,
      // Column names are the spec's; the contents are ciphertext. `filename`
      // holds the encrypted {name, type, size}; the real type is inside it.
      filename: body.encryptedName,
      mimeType: 'application/octet-stream',
      sizeBytes: BigInt(body.sizeBytes),
      storageKey: `${room.id}/${randomUUID()}`,
      encryptedKeyWrapped: fromBase64Url(body.encryptedKeyWrapped),
      checksum: body.checksum,
      expiresAt: new Date(Date.now() + FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    },
    include: withUploader,
  });

  const upload = await presignUpload(file.storageKey, body.sizeBytes);
  return { file: toFileSummary(file), uploadUrl: upload.url, uploadHeaders: upload.headers };
}

/**
 * Called by the uploader once the PUT finished. Trusts nothing the client
 * says: the object must exist in storage at exactly the declared size.
 */
export async function completeFile(
  slug: string,
  userId: string,
  fileId: string,
): Promise<FileSummary> {
  const { room } = await requireMember(slug, userId);
  const file = await prisma.fileMeta.findFirst({
    where: { id: fileId, roomId: room.id, uploaderId: userId },
    include: withUploader,
  });
  if (!file) throw new HttpError('NOT_FOUND', 'No such upload.');
  if (file.uploadedAt) return toFileSummary(file);

  const stored = await objectSize(file.storageKey);
  if (stored === null) throw new HttpError('CONFLICT', 'The upload has not arrived. Try again.');
  if (stored !== Number(file.sizeBytes)) {
    await deleteObject(file.storageKey).catch(() => undefined);
    throw new HttpError(
      'VALIDATION_FAILED',
      'The uploaded file is not the size that was declared.',
    );
  }

  const done = await prisma.fileMeta.update({
    where: { id: file.id },
    data: { uploadedAt: new Date() },
    include: withUploader,
  });
  const summary = toFileSummary(done);
  roomEvents.emit('file-shared', { slug, file: summary });
  return summary;
}

export async function listFiles(slug: string, userId: string): Promise<FileSummary[]> {
  const { room } = await requireMember(slug, userId);
  const files = await prisma.fileMeta.findMany({
    where: { roomId: room.id, uploadedAt: { not: null }, expiresAt: { gt: new Date() } },
    include: withUploader,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return files.map(toFileSummary);
}

export async function downloadUrl(slug: string, userId: string, fileId: string): Promise<string> {
  const { room } = await requireMember(slug, userId);
  const file = await prisma.fileMeta.findFirst({
    where: {
      id: fileId,
      roomId: room.id,
      uploadedAt: { not: null },
      expiresAt: { gt: new Date() },
    },
  });
  if (!file) throw new HttpError('NOT_FOUND', 'That file no longer exists.');
  return presignDownload(file.storageKey);
}

/** The uploader, or the room's host, may delete a file. */
export async function deleteFile(slug: string, userId: string, fileId: string): Promise<void> {
  const { room, member } = await requireMember(slug, userId);
  const file = await prisma.fileMeta.findFirst({ where: { id: fileId, roomId: room.id } });
  if (!file) throw new HttpError('NOT_FOUND', 'That file no longer exists.');
  const isHost = member.role === 'OWNER' || member.role === 'MODERATOR';
  if (file.uploaderId !== userId && !isHost) {
    throw new HttpError('FORBIDDEN', 'Only the person who shared it, or the host, can delete it.');
  }
  await deleteObject(file.storageKey).catch((error: unknown) =>
    logger.warn({ err: error, fileId }, 'object delete failed; the purge job will retry'),
  );
  await prisma.fileMeta.delete({ where: { id: file.id } });
  roomEvents.emit('file-deleted', { slug, fileId: file.id });
}
