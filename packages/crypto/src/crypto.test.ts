import { describe, expect, it } from 'vitest';
import {
  blobChecksum,
  ciphertextSize,
  decryptBlob,
  decryptText,
  DecryptionError,
  encryptBlob,
  encryptText,
  FILE_CHUNK_BYTES,
  generateFileKey,
  generateKeyPair,
  generateRoomKey,
  keyPairFromPrivate,
  lockPrivateKey,
  openSealed,
  roomKeyCheck,
  sealTo,
  unlockPrivateKey,
  unwrapKey,
  wrapKey,
} from './index.js';

const bytes = (n: number, fill = 7): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(fill);

describe('key pairs and sealed boxes', () => {
  it('opens only for the recipient', async () => {
    const alice = await generateKeyPair();
    const eve = await generateKeyPair();
    const roomKey = await generateRoomKey();

    const sealed = await sealTo(alice.publicKey, roomKey);
    expect(await openSealed(alice, sealed)).toEqual(roomKey);
    await expect(openSealed(eve, sealed)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('derives the public key from the private key', async () => {
    const pair = await generateKeyPair();
    expect((await keyPairFromPrivate(pair.privateKey)).publicKey).toEqual(pair.publicKey);
  });
});

describe('password-locked private keys', () => {
  it('round-trips with the right password only', async () => {
    const { privateKey } = await generateKeyPair();
    const blob = await lockPrivateKey(privateKey, 'correct horse battery staple');
    expect(await unlockPrivateKey(blob, 'correct horse battery staple')).toEqual(privateKey);
    await expect(unlockPrivateKey(blob, 'wrong password')).rejects.toBeInstanceOf(DecryptionError);
  });

  it('salts: the same key and password never produce the same blob', async () => {
    const { privateKey } = await generateKeyPair();
    const a = await lockPrivateKey(privateKey, 'pw pw pw pw pw');
    const b = await lockPrivateKey(privateKey, 'pw pw pw pw pw');
    expect(a).not.toEqual(b);
  });

  it('rejects a tampered or unknown-version blob', async () => {
    const { privateKey } = await generateKeyPair();
    const blob = await lockPrivateKey(privateKey, 'pw pw pw pw pw');
    const flipped = blob.slice();
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    await expect(unlockPrivateKey(flipped, 'pw pw pw pw pw')).rejects.toBeInstanceOf(
      DecryptionError,
    );
    const future = blob.slice();
    future[0] = 9;
    await expect(unlockPrivateKey(future, 'pw pw pw pw pw')).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });
});

describe('room keys', () => {
  it('fingerprints stably, and differently per key', async () => {
    const a = await generateRoomKey();
    const b = await generateRoomKey();
    expect(await roomKeyCheck(a)).toBe(await roomKeyCheck(a));
    expect(await roomKeyCheck(a)).not.toBe(await roomKeyCheck(b));
    expect(await roomKeyCheck(a)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('wraps a file key so only the room key unwraps it', async () => {
    const roomKey = await generateRoomKey();
    const fileKey = await generateFileKey();
    const wrapped = await wrapKey(fileKey, roomKey);
    expect(await unwrapKey(wrapped, roomKey)).toEqual(fileKey);
    await expect(unwrapKey(wrapped, await generateRoomKey())).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('encrypts text with a fresh nonce every time', async () => {
    const key = await generateRoomKey();
    const a = await encryptText('quarterly-report.pdf', key);
    expect(a).not.toBe(await encryptText('quarterly-report.pdf', key));
    expect(a).not.toContain('quarterly');
    expect(await decryptText(a, key)).toBe('quarterly-report.pdf');
  });
});

describe('streaming file encryption', () => {
  const sizes = [0, 1, FILE_CHUNK_BYTES - 1, FILE_CHUNK_BYTES, FILE_CHUNK_BYTES * 3 + 123];

  for (const size of sizes) {
    it(`round-trips a ${size}-byte file, at the predicted size`, async () => {
      const key = await generateFileKey();
      const plain = new Blob([bytes(size, size % 251)]);
      const sealed = await encryptBlob(plain, key);
      expect(sealed.size).toBe(ciphertextSize(size));
      const opened = await decryptBlob(sealed, key);
      expect(new Uint8Array(await opened.arrayBuffer())).toEqual(bytes(size, size % 251));
    });
  }

  it('hides the plaintext', async () => {
    const key = await generateFileKey();
    const marker = new TextEncoder().encode('TOP-SECRET-MARKER '.repeat(200));
    const sealed = new Uint8Array(await (await encryptBlob(new Blob([marker]), key)).arrayBuffer());
    expect(new TextDecoder('latin1').decode(sealed)).not.toContain('TOP-SECRET-MARKER');
  });

  it('refuses the wrong key, a flipped bit, and a truncated file', async () => {
    const key = await generateFileKey();
    const sealed = new Uint8Array(
      await (await encryptBlob(new Blob([bytes(FILE_CHUNK_BYTES * 2 + 10)]), key)).arrayBuffer(),
    );

    await expect(decryptBlob(new Blob([sealed]), await generateFileKey())).rejects.toBeInstanceOf(
      DecryptionError,
    );

    const flipped = sealed.slice();
    flipped[100] = (flipped[100] ?? 0) ^ 1;
    await expect(decryptBlob(new Blob([flipped]), key)).rejects.toBeInstanceOf(DecryptionError);

    // Cut the final chunk off: every remaining chunk is valid, but the
    // stream never reaches TAG_FINAL, so it must be refused.
    const truncated = sealed.slice(0, 24 + FILE_CHUNK_BYTES + 17);
    await expect(decryptBlob(new Blob([truncated]), key)).rejects.toThrow('truncated');
  });

  it('checksums the ciphertext deterministically', async () => {
    const blob = new Blob([bytes(FILE_CHUNK_BYTES + 5)]);
    expect(await blobChecksum(blob)).toBe(await blobChecksum(blob));
    expect(await blobChecksum(blob)).toMatch(/^[0-9a-f]{64}$/);
  });
});
