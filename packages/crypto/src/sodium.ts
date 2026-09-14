import _sodium from 'libsodium-wrappers';

/**
 * libsodium compiles from WASM and is unusable until its ready promise settles.
 * Every consumer must await this; calling a primitive before it resolves fails
 * in confusing ways. The real key-management surface (room keys, sealed boxes,
 * secretstream file encryption) lands in Phase 7 and builds on this guard.
 */
let readyPromise: Promise<typeof _sodium> | null = null;

export async function getSodium(): Promise<typeof _sodium> {
  readyPromise ??= _sodium.ready.then(() => _sodium);
  return readyPromise;
}

/** Constant-time comparison. Never compare secrets with `===`. */
export async function timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const sodium = await getSodium();
  if (a.length !== b.length) return false;
  return sodium.memcmp(a, b);
}

export const CRYPTO_PARAMS = {
  /** XChaCha20-Poly1305 nonce, per spec section 7. */
  NONCE_BYTES: 24,
  /** Symmetric room key. */
  KEY_BYTES: 32,
} as const;
