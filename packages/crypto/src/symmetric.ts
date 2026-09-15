import { DecryptionError, fromBase64Url, getSodium, toBase64Url } from './sodium.js';

/**
 * Room keys and single-message symmetric encryption.
 *
 * Every sealed message here is [24-byte random nonce][ciphertext + tag]
 * under XChaCha20-Poly1305. A 24-byte nonce is large enough to pick at
 * random for every message without tracking counters (spec: "a random
 * 24-byte nonce per message").
 */

export async function generateKey(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
}

/** A room's shared symmetric key. */
export const generateRoomKey = generateKey;

/**
 * A short public fingerprint of a room key, stored on the room. Lets a
 * member confirm that the key someone sealed to them is the room's real
 * key, and not garbage or a substitute, without revealing the key.
 */
export async function roomKeyCheck(roomKey: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  const context = new TextEncoder().encode('confluence/room-key-check/v1');
  return sodium.to_hex(sodium.crypto_generichash(16, roomKey, context));
}

export async function encryptBytes(
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData: Uint8Array | null = null,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData,
    null,
    nonce,
    key,
  );
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce);
  out.set(ciphertext, nonce.length);
  return out;
}

export async function decryptBytes(
  sealed: Uint8Array,
  key: Uint8Array,
  associatedData: Uint8Array | null = null,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const n = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (sealed.length <= n) throw new DecryptionError('Too short to be encrypted data.');
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sealed.slice(n),
      associatedData,
      sealed.slice(0, n),
      key,
    );
  } catch {
    throw new DecryptionError();
  }
}

/** Wraps a file key (or any key) under the room key. */
export const wrapKey = (key: Uint8Array, roomKey: Uint8Array): Promise<Uint8Array> =>
  encryptBytes(key, roomKey, new TextEncoder().encode('confluence/wrapped-key/v1'));

export const unwrapKey = (wrapped: Uint8Array, roomKey: Uint8Array): Promise<Uint8Array> =>
  decryptBytes(wrapped, roomKey, new TextEncoder().encode('confluence/wrapped-key/v1'));

/** Text (a file name, a chat message) to a compact base64url string. */
export async function encryptText(text: string, key: Uint8Array): Promise<string> {
  return toBase64Url(await encryptBytes(new TextEncoder().encode(text), key));
}

export async function decryptText(encoded: string, key: Uint8Array): Promise<string> {
  return new TextDecoder().decode(await decryptBytes(await fromBase64Url(encoded), key));
}
