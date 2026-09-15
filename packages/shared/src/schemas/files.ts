import { z } from 'zod';
import { base64UrlSchema } from './keys.js';

/** Spec: 100 MB maximum per file (plaintext). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Ciphertext is slightly larger than plaintext: a 24-byte stream header plus
 * 17 bytes per 64 KiB chunk (see packages/crypto files.ts). The server
 * enforces the limit on what it actually stores.
 */
export const MAX_CIPHERTEXT_BYTES = 24 + MAX_FILE_BYTES + Math.ceil(MAX_FILE_BYTES / 65536) * 17;

/** How long a persisted file lives before the purge job removes it. */
export const FILE_RETENTION_DAYS = 7;

export const createFileRequestSchema = z.object({
  /** Exact ciphertext size; the presigned upload is bound to it. */
  sizeBytes: z.number().int().positive().max(MAX_CIPHERTEXT_BYTES),
  /** Name and type, encrypted with the file key. The server never sees them. */
  encryptedName: base64UrlSchema(2048),
  /** The file key, encrypted with the room key. */
  encryptedKeyWrapped: base64UrlSchema(256),
  /** BLAKE2b-256 of the ciphertext, hex. */
  checksum: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a 64-character hex checksum'),
});

export const fileSummarySchema = z.object({
  id: z.string(),
  encryptedName: z.string(),
  encryptedKeyWrapped: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string(),
  uploader: z.object({ userId: z.string(), displayName: z.string() }),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const createFileResponseSchema = z.object({
  file: fileSummarySchema,
  /** Presigned PUT to object storage; the API never proxies file bytes. */
  uploadUrl: z.string().url(),
  /** Headers the upload must send exactly (they are part of the signature). */
  uploadHeaders: z.record(z.string(), z.string()),
});

export const fileResponseSchema = z.object({ file: fileSummarySchema });
export const fileListResponseSchema = z.object({ files: z.array(fileSummarySchema) });
export const fileDownloadResponseSchema = z.object({ url: z.string().url() });

/** What sits inside `encryptedName` once decrypted. */
export const fileMetaPlaintextSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().max(127),
  size: z.number().int().nonnegative(),
});

export type CreateFileRequest = z.infer<typeof createFileRequestSchema>;
export type FileSummary = z.infer<typeof fileSummarySchema>;
export type CreateFileResponse = z.infer<typeof createFileResponseSchema>;
export type FileMetaPlaintext = z.infer<typeof fileMetaPlaintextSchema>;
