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

/**
 * A public key's safety code: 30 digits in six groups of five, for people to
 * compare by reading them aloud or over another channel. Everyone's screen
 * should show the same code for the same person; a different code means the
 * key the server handed out is not the one that person holds.
 */
export async function safetyCode(publicKey: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  const context = new TextEncoder().encode('confluence/safety-code/v1');
  const hash = sodium.crypto_generichash(30, publicKey, context);
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) {
    // 5 bytes = 40 bits, exact in a double; reduce to 5 decimal digits.
    let n = 0;
    for (const byte of hash.subarray(i * 5, i * 5 + 5)) n = n * 256 + byte;
    groups.push(String(n % 100_000).padStart(5, '0'));
  }
  return groups.join(' ');
}
