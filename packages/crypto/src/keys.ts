import { DecryptionError, getSodium } from './sodium.js';

/**
 * Per-user X25519 key pairs, and the sealed boxes that deliver room keys.
 *
 * A room key reaches a member as crypto_box_seal(roomKey, member.publicKey):
 * anyone can seal to a public key, only the private key opens it, and the
 * sender stays anonymous (the server cannot learn who wrapped it for whom
 * from the ciphertext alone).
 */

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const sodium = await getSodium();
  const { publicKey, privateKey } = sodium.crypto_box_keypair();
  return { publicKey, privateKey };
}

/** Rebuilds the pair from the private key (the public key is derivable). */
export async function keyPairFromPrivate(privateKey: Uint8Array): Promise<KeyPair> {
  const sodium = await getSodium();
  return { publicKey: sodium.crypto_scalarmult_base(privateKey), privateKey };
}

export async function sealTo(
  recipientPublicKey: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_box_seal(message, recipientPublicKey);
}

export async function openSealed(keyPair: KeyPair, sealed: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium();
  try {
    return sodium.crypto_box_seal_open(sealed, keyPair.publicKey, keyPair.privateKey);
  } catch {
    throw new DecryptionError('This key was not sealed to you.');
  }
}
