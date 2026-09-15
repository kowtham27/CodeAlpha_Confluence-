import { DecryptionError, getSodium } from './sodium.js';

/**
 * Streaming file encryption with libsodium's secretstream
 * (XChaCha20-Poly1305), spec Phase 5.
 *
 * Format: [24-byte stream header] then, per 64 KiB plaintext chunk,
 * [chunk + 17 bytes of tag/MAC]. The last chunk carries TAG_FINAL. Each chunk
 * is authenticated and ordered, so a flipped bit, a reordered chunk, or a
 * truncated file all fail decryption instead of yielding altered plaintext.
 *
 * Works chunk by chunk from a Blob, so a 100 MB file is never held twice in
 * memory as plaintext and ciphertext at once.
 */

export const FILE_CHUNK_BYTES = 64 * 1024;
const HEADER_BYTES = 24;
const CHUNK_OVERHEAD = 17;

export type Progress = (done: number, total: number) => void;

export async function generateFileKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_secretstream_xchacha20poly1305_keygen();
}

/** Exact ciphertext size for a plaintext of `size` bytes. */
export function ciphertextSize(size: number): number {
  const chunks = Math.max(1, Math.ceil(size / FILE_CHUNK_BYTES));
  return HEADER_BYTES + size + chunks * CHUNK_OVERHEAD;
}

export async function encryptBlob(
  blob: Blob,
  key: Uint8Array,
  onProgress?: Progress,
): Promise<Blob> {
  const sodium = await getSodium();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const parts: BlobPart[] = [header as Uint8Array<ArrayBuffer>];
  const total = blob.size;
  let offset = 0;
  do {
    const end = Math.min(offset + FILE_CHUNK_BYTES, total);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    const tag =
      end >= total
        ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    parts.push(
      sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        chunk,
        null,
        tag,
      ) as Uint8Array<ArrayBuffer>,
    );
    offset = end;
    onProgress?.(offset, total);
  } while (offset < total);
  return new Blob(parts, { type: 'application/octet-stream' });
}

export async function decryptBlob(
  blob: Blob,
  key: Uint8Array,
  type = 'application/octet-stream',
  onProgress?: Progress,
): Promise<Blob> {
  const sodium = await getSodium();
  if (blob.size < HEADER_BYTES + CHUNK_OVERHEAD) throw new DecryptionError('File is truncated.');
  const header = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  let state;
  try {
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  } catch {
    throw new DecryptionError();
  }

  const parts: BlobPart[] = [];
  const total = blob.size;
  let offset = HEADER_BYTES;
  let finished = false;
  while (offset < total) {
    if (finished) throw new DecryptionError('Data after the end of the file.');
    const end = Math.min(offset + FILE_CHUNK_BYTES + CHUNK_OVERHEAD, total);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk, null);
    // libsodium-wrappers returns false (not a throw) for a forged chunk.
    if (!result) throw new DecryptionError('File was altered or the key is wrong.');
    parts.push(result.message as Uint8Array<ArrayBuffer>);
    finished = result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
    offset = end;
    onProgress?.(offset, total);
  }
  if (!finished) throw new DecryptionError('File is truncated.');
  return new Blob(parts, { type });
}

/**
 * BLAKE2b-256 of a blob, streamed. Stored as FileMeta.checksum, computed over
 * the CIPHERTEXT: it proves the stored object is intact without letting the
 * server confirm guesses about the plaintext (a plaintext hash would).
 */
export async function blobChecksum(blob: Blob): Promise<string> {
  const sodium = await getSodium();
  const state = sodium.crypto_generichash_init(null, 32);
  for (let offset = 0; offset < blob.size; offset += FILE_CHUNK_BYTES) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer());
    sodium.crypto_generichash_update(state, chunk);
  }
  return sodium.to_hex(sodium.crypto_generichash_final(state, 32));
}
