import _sodium from 'libsodium-wrappers-sumo';

/**
 * libsodium compiles from WASM and is unusable until its ready promise
 * settles. Every helper in this package awaits this first.
 *
 * The "sumo" build is required: the standard build omits crypto_pwhash
 * (Argon2id), which protects users' private keys.
 */
export type Sodium = typeof _sodium;

let ready: Promise<Sodium> | null = null;

export function getSodium(): Promise<Sodium> {
  ready ??= _sodium.ready.then(() => _sodium);
  return ready;
}

/** Any failed decryption: wrong key, tampered bytes, truncated stream. */
export class DecryptionError extends Error {
  constructor(message = 'Could not decrypt: wrong key or damaged data.') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export async function toBase64Url(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export async function fromBase64Url(text: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  try {
    return sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new DecryptionError('Malformed encoded data.');
  }
}

/** Constant-time comparison. Never compare secrets with `===`. */
export async function timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const sodium = await getSodium();
  if (a.length !== b.length) return false;
  return sodium.memcmp(a, b);
}

export const CRYPTO_PARAMS = {
  /** XChaCha20-Poly1305 nonce. */
  NONCE_BYTES: 24,
  /** Symmetric keys: room keys, file keys. */
  KEY_BYTES: 32,
} as const;
