import { DecryptionError, getSodium } from './sodium.js';

/**
 * Protects a user's private key with their password, so the server can store
 * it (and hand it to any device they sign in on) without being able to use it.
 *
 * Blob, version 1:
 *   [1 byte  version = 1]
 *   [16 bytes Argon2id salt]
 *   [24 bytes XChaCha20-Poly1305 nonce]
 *   [ciphertext of the 32-byte private key + 16-byte tag]
 *
 * The KDF runs in the browser. Argon2id at "interactive" cost (2 passes,
 * 64 MB) takes a fraction of a second on a laptop and makes offline guessing
 * against a stolen blob expensive. The server never sees the password-derived
 * key: login proves the password to the server with a separate server-side
 * Argon2id hash, and this blob is only ever decrypted client-side.
 */

const VERSION = 1;
const AAD = new TextEncoder().encode('confluence/private-key/v1');

async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    password,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function lockPrivateKey(
  privateKey: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const key = await deriveKey(password, salt);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    privateKey,
    AAD,
    null,
    nonce,
    key,
  );
  sodium.memzero(key);

  const blob = new Uint8Array(1 + salt.length + nonce.length + ciphertext.length);
  blob[0] = VERSION;
  blob.set(salt, 1);
  blob.set(nonce, 1 + salt.length);
  blob.set(ciphertext, 1 + salt.length + nonce.length);
  return blob;
}

export async function unlockPrivateKey(blob: Uint8Array, password: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  const saltEnd = 1 + sodium.crypto_pwhash_SALTBYTES;
  const nonceEnd = saltEnd + sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (blob[0] !== VERSION || blob.length <= nonceEnd) {
    throw new DecryptionError('Unrecognised key format.');
  }
  const key = await deriveKey(password, blob.slice(1, saltEnd));
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      blob.slice(nonceEnd),
      AAD,
      blob.slice(saltEnd, nonceEnd),
      key,
    );
  } catch {
    throw new DecryptionError('Wrong password for this key.');
  } finally {
    sodium.memzero(key);
  }
}
