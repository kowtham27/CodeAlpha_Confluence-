import { create } from 'zustand';
import type { KeyPair } from '@confluence/crypto';
import { useAuth } from '../../stores/auth';
import { ApiError } from '../api';
import { loadE2E } from '../e2e';
import { getMyKeys, setMyKeys } from './api';
import { clearDeviceKeys, loadDeviceKey, saveDeviceKey } from './device-store';

/**
 * The signed-in user's end-to-end key pair, in memory.
 *
 * - At sign-in (the only time we have the password) the private key is
 *   unlocked, or created on first use, and kept on this device.
 * - On a reload the session comes back without a password, so the key is
 *   restored from the device store instead.
 * - If neither works (another browser, cleared storage), the status is
 *   'locked' and the UI asks for the password.
 */
export type KeyStatus = 'idle' | 'working' | 'ready' | 'locked' | 'error';

interface KeyState {
  status: KeyStatus;
  userId: string | null;
  keyPair: KeyPair | null;
  error: string | null;
}

export const useKeys = create<KeyState>()(() => ({
  status: 'idle',
  userId: null,
  keyPair: null,
  error: null,
}));

// Every operation runs after the previous one: a restore racing an unlock
// must not overwrite 'ready' with 'locked'.
let queue: Promise<void> = Promise.resolve();
function serial(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task, task);
  return queue;
}

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Could not set up encryption keys.';

async function becomeReady(userId: string, keyPair: KeyPair): Promise<void> {
  useKeys.setState({ status: 'ready', userId, keyPair, error: null });
  try {
    await saveDeviceKey(userId, keyPair.publicKey, keyPair.privateKey);
  } catch (error) {
    // Private windows may refuse IndexedDB: it works, but asks again next load.
    console.warn('could not keep keys on this device', error);
  }
}

/**
 * Unlocks (or on first use creates and publishes) the key pair with the
 * account password. Throws a readable Error when the password does not open
 * the stored key.
 */
export function unlockWithPassword(userId: string, password: string): Promise<void> {
  return serial(async () => {
    useKeys.setState({ status: 'working', userId, error: null });
    try {
      const e2e = await loadE2E();
      let remote = await getMyKeys();

      if (!remote.publicKey || !remote.encryptedPrivateKey) {
        const keyPair = await e2e.generateKeyPair();
        try {
          await setMyKeys({
            publicKey: await e2e.toBase64Url(keyPair.publicKey),
            encryptedPrivateKey: await e2e.toBase64Url(
              await e2e.lockPrivateKey(keyPair.privateKey, password),
            ),
          });
          await becomeReady(userId, keyPair);
          return;
        } catch (error) {
          // Another tab created them first: fall through and unlock those.
          if (!(error instanceof ApiError && error.code === 'CONFLICT')) throw error;
          remote = await getMyKeys();
        }
      }

      const blob = await e2e.fromBase64Url(remote.encryptedPrivateKey ?? '');
      let privateKey: Uint8Array;
      try {
        privateKey = await e2e.unlockPrivateKey(blob, password);
      } catch {
        useKeys.setState({ status: 'locked', error: 'That password did not unlock your keys.' });
        return;
      }
      await becomeReady(userId, await e2e.keyPairFromPrivate(privateKey));
    } catch (error) {
      useKeys.setState({ status: 'error', error: describe(error) });
    }
  });
}

/** After a reload: take the key from this device, if it still matches the account. */
export function restoreKeys(userId: string): Promise<void> {
  return serial(async () => {
    const { status, userId: current } = useKeys.getState();
    if (status === 'ready' && current === userId) return;
    useKeys.setState({ status: 'working', userId, error: null });
    try {
      const [stored, remote, e2e] = await Promise.all([
        loadDeviceKey(userId).catch(() => null),
        getMyKeys(),
        loadE2E(),
      ]);
      const matches =
        stored !== null &&
        remote.publicKey !== null &&
        remote.publicKey === (await e2e.toBase64Url(stored.publicKey));
      if (!matches) {
        // No key here, or the account's keys were reset since it was saved.
        if (stored) await clearDeviceKeys().catch(() => undefined);
        useKeys.setState({ status: 'locked', keyPair: null });
        return;
      }
      useKeys.setState({
        status: 'ready',
        keyPair: await e2e.keyPairFromPrivate(stored.privateKey),
        error: null,
      });
    } catch (error) {
      useKeys.setState({ status: 'error', error: describe(error) });
    }
  });
}

/**
 * Called by sign-in just before the session is set, so the session listener
 * below does not start a pointless device restore: the password is coming.
 */
export function expectPassword(): void {
  if (useKeys.getState().status === 'idle') useKeys.setState({ status: 'working' });
}

export function forgetKeys(): Promise<void> {
  return serial(async () => {
    useKeys.setState({ status: 'idle', userId: null, keyPair: null, error: null });
    await clearDeviceKeys().catch(() => undefined);
  });
}

// Follow the session: restore when a session appears without a password
// (reload, another tab), forget when it ends for any reason.
useAuth.subscribe((auth, previous) => {
  if (auth.status === 'anonymous' && previous.status === 'authenticated') {
    void forgetKeys();
  }
  const userId = auth.user?.id;
  if (auth.status === 'authenticated' && userId && useKeys.getState().status === 'idle') {
    void restoreKeys(userId);
  }
});
