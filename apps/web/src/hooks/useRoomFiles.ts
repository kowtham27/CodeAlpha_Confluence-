import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fileMetaPlaintextSchema,
  type FileMetaPlaintext,
  type FileSummary,
} from '@confluence/shared';
import { ApiError } from '../lib/api';
import { loadE2E } from '../lib/e2e';
import {
  completeFile,
  createFile,
  deleteFile,
  downloadUrl,
  fetchFromStorage,
  listFiles,
  putToStorage,
} from '../lib/files/api';
import { saveBlob } from '../lib/files/save';
import { useSocket } from '../lib/realtime-context';

export interface RoomFile {
  summary: FileSummary;
  /** Null when it cannot be decrypted (shared under a room key since lost). */
  meta: FileMetaPlaintext | null;
}

export interface Upload {
  key: string;
  name: string;
  size: number;
  phase: 'encrypting' | 'uploading' | 'finishing' | 'failed';
  /** 0..1 within the current phase. */
  progress: number;
  error: string | null;
}

export interface Download {
  phase: 'downloading' | 'decrypting';
  progress: number;
}

const message = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback;

async function openSummary(summary: FileSummary, roomKey: Uint8Array): Promise<RoomFile> {
  try {
    const e2e = await loadE2E();
    const fileKey = await e2e.unwrapKey(
      await e2e.fromBase64Url(summary.encryptedKeyWrapped),
      roomKey,
    );
    const meta = fileMetaPlaintextSchema.parse(
      JSON.parse(await e2e.decryptText(summary.encryptedName, fileKey)),
    );
    return { summary, meta };
  } catch {
    return { summary, meta: null };
  }
}

/**
 * The room's persisted, end-to-end encrypted files (spec Phase 5b). Every
 * name shown and every byte saved was decrypted here, in the browser; the
 * server and the storage bucket only ever held ciphertext.
 */
export function useRoomFiles(slug: string, roomKey: Uint8Array | null) {
  const socket = useSocket();
  const [files, setFiles] = useState<RoomFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [downloads, setDownloads] = useState<Map<string, Download>>(new Map());
  const controllers = useRef(new Map<string, AbortController>());

  const upsert = useCallback((file: RoomFile) => {
    setFiles((prev) =>
      [file, ...prev.filter((f) => f.summary.id !== file.summary.id)].sort((a, b) =>
        b.summary.createdAt.localeCompare(a.summary.createdAt),
      ),
    );
  }, []);

  // ---- the list, kept live ------------------------------------------------------
  useEffect(() => {
    if (!roomKey) return;
    let cancelled = false;
    listFiles(slug)
      .then((summaries) => Promise.all(summaries.map((s) => openSummary(s, roomKey))))
      .then((opened) => {
        if (cancelled) return;
        setFiles(opened);
        setLoaded(true);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(message(caught, 'Could not load the shared files.'));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, roomKey]);

  useEffect(() => {
    if (!socket || !roomKey) return;
    const onShared = (e: { slug: string; file: FileSummary }) => {
      if (e.slug === slug) void openSummary(e.file, roomKey).then(upsert);
    };
    const onDeleted = (e: { slug: string; fileId: string }) => {
      if (e.slug === slug) setFiles((prev) => prev.filter((f) => f.summary.id !== e.fileId));
    };
    socket.on('file:shared', onShared);
    socket.on('file:deleted', onDeleted);
    return () => {
      socket.off('file:shared', onShared);
      socket.off('file:deleted', onDeleted);
    };
  }, [socket, slug, roomKey, upsert]);

  // Leaving the room abandons unfinished transfers.
  useEffect(() => {
    const live = controllers.current;
    return () => {
      for (const c of live.values()) c.abort();
    };
  }, []);

  // ---- upload --------------------------------------------------------------------
  const patchUpload = (key: string, patch: Partial<Upload>) =>
    setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  /** `type` is the sniffed content type (see sniffFile), never the browser's guess. */
  const upload = useCallback(
    async (file: File, type: string) => {
      if (!roomKey) return;
      const key = crypto.randomUUID();
      const controller = new AbortController();
      controllers.current.set(key, controller);
      setUploads((prev) => [
        ...prev,
        { key, name: file.name, size: file.size, phase: 'encrypting', progress: 0, error: null },
      ]);
      let createdId: string | null = null;
      try {
        const e2e = await loadE2E();
        const fileKey = await e2e.generateFileKey();
        const ciphertext = await e2e.encryptBlob(file, fileKey, (done, total) =>
          patchUpload(key, { progress: done / total }),
        );
        controller.signal.throwIfAborted();

        const created = await createFile(slug, {
          sizeBytes: ciphertext.size,
          encryptedName: await e2e.encryptText(
            JSON.stringify({ name: file.name, type, size: file.size }),
            fileKey,
          ),
          encryptedKeyWrapped: await e2e.toBase64Url(await e2e.wrapKey(fileKey, roomKey)),
          checksum: await e2e.blobChecksum(ciphertext),
        });
        createdId = created.file.id;
        patchUpload(key, { phase: 'uploading', progress: 0 });
        await putToStorage(
          created,
          ciphertext,
          (sent, total) => patchUpload(key, { progress: sent / total }),
          controller.signal,
        );

        patchUpload(key, { phase: 'finishing', progress: 1 });
        const done = await completeFile(slug, created.file.id);
        upsert({ summary: done, meta: { name: file.name, type, size: file.size } });
        setUploads((prev) => prev.filter((u) => u.key !== key));
      } catch (caught) {
        // A half-made upload is cleaned up now rather than waiting for the purge.
        if (createdId) void deleteFile(slug, createdId).catch(() => undefined);
        if (controller.signal.aborted) {
          setUploads((prev) => prev.filter((u) => u.key !== key));
        } else {
          patchUpload(key, { phase: 'failed', error: message(caught, 'The upload failed.') });
        }
      } finally {
        controllers.current.delete(key);
      }
    },
    [slug, roomKey, upsert],
  );

  const cancelUpload = useCallback((key: string) => controllers.current.get(key)?.abort(), []);
  const dismissUpload = useCallback(
    (key: string) => setUploads((prev) => prev.filter((u) => u.key !== key)),
    [],
  );

  // ---- download ------------------------------------------------------------------
  const setDownload = (id: string, value: Download | null) =>
    setDownloads((prev) => {
      const next = new Map(prev);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });

  const download = useCallback(
    async (file: RoomFile) => {
      const { summary, meta } = file;
      if (!roomKey || !meta) return;
      const controller = new AbortController();
      controllers.current.set(summary.id, controller);
      setError(null);
      setDownload(summary.id, { phase: 'downloading', progress: 0 });
      try {
        const e2e = await loadE2E();
        const url = await downloadUrl(slug, summary.id);
        const ciphertext = await fetchFromStorage(
          url,
          summary.sizeBytes,
          (received, total) =>
            setDownload(summary.id, { phase: 'downloading', progress: received / total }),
          controller.signal,
        );
        // The storage bucket is not trusted either: what came back must be
        // exactly what the uploader encrypted.
        if ((await e2e.blobChecksum(ciphertext)) !== summary.checksum) {
          throw new Error('checksum mismatch');
        }
        const fileKey = await e2e.unwrapKey(
          await e2e.fromBase64Url(summary.encryptedKeyWrapped),
          roomKey,
        );
        const plain = await e2e.decryptBlob(ciphertext, fileKey, meta.type, (done, total) =>
          setDownload(summary.id, { phase: 'decrypting', progress: done / total }),
        );
        saveBlob(plain, meta.name);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(
            caught instanceof ApiError
              ? caught.message
              : `“${meta.name}” could not be decrypted. It may have been damaged.`,
          );
        }
      } finally {
        controllers.current.delete(summary.id);
        setDownload(summary.id, null);
      }
    },
    [slug, roomKey],
  );

  const remove = useCallback(
    async (file: RoomFile) => {
      setError(null);
      try {
        await deleteFile(slug, file.summary.id);
        setFiles((prev) => prev.filter((f) => f.summary.id !== file.summary.id));
      } catch (caught) {
        setError(message(caught, 'Could not delete that file.'));
      }
    },
    [slug],
  );

  return {
    files,
    loaded,
    error,
    uploads,
    downloads,
    upload,
    cancelUpload,
    dismissUpload,
    download,
    remove,
  };
}
