import { z } from 'zod';

/**
 * End-to-end key material. Everything here is opaque to the server: public
 * keys, and blobs sealed or encrypted client-side. The server validates only
 * shape and size, never contents it cannot read anyway.
 */

/** base64url, no padding, bounded. */
export const base64UrlSchema = (maxChars: number) =>
  z
    .string()
    .min(1)
    .max(maxChars)
    .regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url');

/** X25519 public key: 32 bytes = 43 base64url characters. */
export const publicKeySchema = base64UrlSchema(43).length(43);

export const userKeysSchema = z.object({
  publicKey: publicKeySchema.nullable(),
  /** The private key, locked with a key derived from the user's password. */
  encryptedPrivateKey: base64UrlSchema(512).nullable(),
});

export const setUserKeysRequestSchema = z.object({
  publicKey: publicKeySchema,
  encryptedPrivateKey: base64UrlSchema(512),
});

export const roomKeyCheckSchema = z.string().regex(/^[0-9a-f]{32}$/, 'Expected a key fingerprint');

/** A 32-byte room key sealed to a public key: 80 bytes = 107 characters. */
export const sealedRoomKeySchema = base64UrlSchema(256);

export const roomKeyStateSchema = z.object({
  /** Null until someone initialises the room's key. */
  keyCheck: roomKeyCheckSchema.nullable(),
  /** The room key sealed to the caller, or null if nobody has granted it yet. */
  wrappedRoomKey: sealedRoomKeySchema.nullable(),
});

export const initRoomKeyRequestSchema = z.object({
  keyCheck: roomKeyCheckSchema,
  wrappedRoomKey: sealedRoomKeySchema,
});

export const grantRoomKeyRequestSchema = z.object({
  userId: z.string().min(1).max(64),
  wrappedRoomKey: sealedRoomKeySchema,
});

export const keyRequestSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  publicKey: publicKeySchema,
});

export const keyRequestsResponseSchema = z.object({ requests: z.array(keyRequestSchema) });

export type UserKeys = z.infer<typeof userKeysSchema>;
export type SetUserKeysRequest = z.infer<typeof setUserKeysRequestSchema>;
export type RoomKeyState = z.infer<typeof roomKeyStateSchema>;
export type InitRoomKeyRequest = z.infer<typeof initRoomKeyRequestSchema>;
export type GrantRoomKeyRequest = z.infer<typeof grantRoomKeyRequestSchema>;
export type KeyRequest = z.infer<typeof keyRequestSchema>;
