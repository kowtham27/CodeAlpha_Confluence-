import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyPair } from '@confluence/crypto';
import { ApiError } from '../lib/api';
import { loadE2E } from '../lib/e2e';
import {
  clearMyRoomKey,
  getKeyRequests,
  getRoomKey,
  grantRoomKey,
  initRoomKey,
} from '../lib/keys/api';
import { useKeys } from '../lib/keys/keystore';
import { useSocket } from '../lib/realtime-context';

export type RoomKeyState =
  /** Our own key pair is still loading. */
  | { status: 'unlocking' }
  /** Our own key pair needs the password (see UnlockKeys). */
  | { status: 'locked' }
  | { status: 'loading' }
  /** The room has a key but nobody has shared it with us yet. */
  | { status: 'waiting' }
  | { status: 'ready'; roomKey: Uint8Array }
  | { status: 'error'; message: string };

/**
 * Obtains this room's key: creates it if the room has none, opens the copy
 * sealed to us if there is one, or waits for a member to grant it.
 *
 * Once we hold it, we grant it to members who ask, but only to people who
 * are in the call right now (`presentUserIds`), where the user can see who
 * they are sharing with.
 */
export function useRoomKey(slug: string, presentUserIds: readonly string[]): RoomKeyState {
  const socket = useSocket();
  const keyStatus = useKeys((s) => s.status);
  const keyPair = useKeys((s) => s.keyPair);
  const [state, setState] = useState<RoomKeyState>({ status: 'loading' });
  const roomKey = useRef<Uint8Array | null>(null);
  const present = useRef(presentUserIds);
  present.current = presentUserIds;

  // Requesters we passed over because they were not in our participant list
  // (yet: their request can arrive a moment before their join renders).
  const skipped = useRef(new Set<string>());
  const granting = useRef<Promise<void> | null>(null);

  const grantPending = useCallback((): Promise<void> => {
    const key = roomKey.current;
    if (!key) return Promise.resolve();
    // One pass at a time; a request during a pass is covered by a second one.
    const run = async () => {
      const e2e = await loadE2E();
      for (const r of await getKeyRequests(slug)) {
        if (!present.current.includes(r.userId)) {
          skipped.current.add(r.userId);
          continue;
        }
        skipped.current.delete(r.userId);
        const sealed = await e2e.sealTo(await e2e.fromBase64Url(r.publicKey), key);
        await grantRoomKey(slug, r.userId, await e2e.toBase64Url(sealed)).catch((error: unknown) =>
          console.warn('could not share the room key', r.userId, error),
        );
      }
    };
    const next = (granting.current ?? Promise.resolve()).then(run, run).finally(() => {
      if (granting.current === next) granting.current = null;
    });
    granting.current = next;
    return next;
  }, [slug]);

  const resolve = useCallback(
    async (pair: KeyPair) => {
      try {
        const key = await obtainRoomKey(slug, pair);
        roomKey.current = key;
        setState(key ? { status: 'ready', roomKey: key } : { status: 'waiting' });
        if (key) await grantPending().catch(() => undefined);
      } catch (error) {
        setState({
          status: 'error',
          message: error instanceof ApiError ? error.message : 'Could not load this room’s key.',
        });
      }
    },
    [slug, grantPending],
  );

  // Our own keys gate everything else.
  useEffect(() => {
    if (keyStatus === 'locked') setState({ status: 'locked' });
    else if (keyStatus === 'error')
      setState({ status: 'error', message: 'Encryption keys failed to load.' });
    else if (keyStatus !== 'ready' || !keyPair) setState({ status: 'unlocking' });
    else void resolve(keyPair);
  }, [keyStatus, keyPair, resolve]);

  useEffect(() => {
    if (!socket || !keyPair) return;
    const onRequested = (e: { slug: string }) => {
      if (e.slug === slug && roomKey.current) void grantPending().catch(() => undefined);
    };
    const onGranted = (e: { slug: string }) => {
      if (e.slug === slug && !roomKey.current) void resolve(keyPair);
    };
    // Grants that happened while we were disconnected sent no event to us.
    const onConnect = () => {
      if (!roomKey.current) void resolve(keyPair);
    };
    socket.on('room:key-requested', onRequested);
    socket.on('room:key-granted', onGranted);
    socket.on('connect', onConnect);
    return () => {
      socket.off('room:key-requested', onRequested);
      socket.off('room:key-granted', onGranted);
      socket.off('connect', onConnect);
    };
  }, [socket, slug, keyPair, resolve, grantPending]);

  // Someone we passed over gets the key once they show up in the call. Only
  // then: re-checking on every join and leave would poll the server for
  // nothing (the server announces every new request).
  const presentKey = presentUserIds.join(',');
  useEffect(() => {
    const ids = presentKey.split(',');
    if (roomKey.current && [...skipped.current].some((id) => ids.includes(id))) {
      void grantPending().catch(() => undefined);
    }
  }, [presentKey, grantPending]);

  return state;
}

async function obtainRoomKey(
  slug: string,
  pair: KeyPair,
  retry = true,
): Promise<Uint8Array | null> {
  const e2e = await loadE2E();
  let remote = await getRoomKey(slug);

  // No key yet, or one that nobody holds any more: make one.
  if (!remote.keyCheck || (!remote.wrappedRoomKey && remote.holders === 0)) {
    const key = await e2e.generateRoomKey();
    try {
      await initRoomKey(slug, {
        keyCheck: await e2e.roomKeyCheck(key),
        wrappedRoomKey: await e2e.toBase64Url(await e2e.sealTo(pair.publicKey, key)),
      });
      return key;
    } catch (error) {
      // Someone else created it first: use theirs.
      if (!(error instanceof ApiError && error.code === 'CONFLICT')) throw error;
      remote = await getRoomKey(slug);
    }
  }

  if (!remote.wrappedRoomKey) return null;
  try {
    const key = await e2e.openSealed(pair, await e2e.fromBase64Url(remote.wrappedRoomKey));
    // A key that does not match the room's fingerprint is not this room's
    // key, whoever sealed it: never encrypt anything with it.
    if ((await e2e.roomKeyCheck(key)) === remote.keyCheck) return key;
  } catch {
    // Sealed to a key pair we no longer have.
  }
  // Drop the useless copy and ask for a fresh one. If ours was the only copy,
  // the key is now lost and the retry creates a new one.
  await clearMyRoomKey(slug);
  return retry ? obtainRoomKey(slug, pair, false) : null;
}
