/**
 * Keeps the user's unlocked private key on this device between page loads,
 * so a reload (which restores the session from the refresh cookie, without a
 * password) does not ask for the password again.
 *
 * The private key is never stored in the clear. It is encrypted with an
 * AES-GCM "device key" that WebCrypto generated as non-extractable: page
 * script can ask the browser to decrypt with it, but can never read the key
 * itself. So a script that runs on this page later cannot copy the private
 * key off the device to use elsewhere. (A script running while the page is
 * open can still use it here: see SECURITY.md.) Cleared on sign-out.
 */

const DB_NAME = 'confluence-keys';
const STORE = 'device-keys';

interface StoredKey {
  userId: string;
  publicKey: Uint8Array;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  deviceKey: CryptoKey;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'userId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
  } finally {
    db.close();
  }
}

const bytes = (view: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(view);

export async function saveDeviceKey(
  userId: string,
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<void> {
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    deviceKey,
    bytes(privateKey),
  );
  const record: StoredKey = { userId, publicKey: bytes(publicKey), iv, ciphertext, deviceKey };
  await run('readwrite', (store) => store.put(record));
}

/** The stored private key for `userId`, with the public key it belongs to; null if none. */
export async function loadDeviceKey(
  userId: string,
): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array } | null> {
  const record = (await run('readonly', (store) => store.get(userId))) as StoredKey | undefined;
  if (!record) return null;
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes(record.iv) },
    record.deviceKey,
    record.ciphertext,
  );
  return { publicKey: record.publicKey, privateKey: new Uint8Array(plain) };
}

export async function clearDeviceKeys(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}
