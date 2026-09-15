import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { roomEvents } from '../../lib/room-events.js';
import { deleteObject } from '../../lib/storage.js';

/**
 * Spec: files expire and are purged after 7 days by a scheduled job.
 *
 * Also removes uploads that were started but never completed (the browser
 * went away mid-upload) after an hour, object and row both. Runs on every
 * API instance, but a Redis lock lets only one of them do a given run.
 */

const LOCK_KEY = 'jobs:file-purge';
const LOCK_SECONDS = 300;
const ABANDONED_UPLOAD_MS = 60 * 60 * 1000;
const BATCH = 500;

export interface PurgeResult {
  expired: number;
  abandoned: number;
}

export async function purgeFiles(now: Date = new Date()): Promise<PurgeResult> {
  const doomed = await prisma.fileMeta.findMany({
    where: {
      OR: [
        { expiresAt: { lte: now } },
        { uploadedAt: null, createdAt: { lte: new Date(now.getTime() - ABANDONED_UPLOAD_MS) } },
      ],
    },
    include: { room: { select: { slug: true } } },
    take: BATCH,
  });

  let expired = 0;
  let abandoned = 0;
  for (const file of doomed) {
    try {
      // Object first: a row without an object is harmless, an object without
      // a row is unreachable storage that nothing would ever clean up.
      await deleteObject(file.storageKey);
    } catch (error) {
      logger.warn({ err: error, fileId: file.id }, 'purge could not delete object; will retry');
      continue;
    }
    await prisma.fileMeta.delete({ where: { id: file.id } });
    if (file.uploadedAt) {
      expired += 1;
      roomEvents.emit('file-deleted', { slug: file.room.slug, fileId: file.id });
    } else {
      abandoned += 1;
    }
  }
  return { expired, abandoned };
}

/** Starts the schedule. Returns a stop function. */
export function startFilePurge(intervalMs = 30 * 60 * 1000): () => void {
  const run = async (): Promise<void> => {
    const locked = await redis.set(LOCK_KEY, String(process.pid), 'EX', LOCK_SECONDS, 'NX');
    if (locked !== 'OK') return; // another instance is purging
    try {
      const result = await purgeFiles();
      if (result.expired + result.abandoned > 0) logger.info(result, 'purged files');
    } finally {
      await redis.del(LOCK_KEY);
    }
  };
  const timer = setInterval(() => {
    run().catch((error: unknown) => logger.error({ err: error }, 'file purge failed'));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
