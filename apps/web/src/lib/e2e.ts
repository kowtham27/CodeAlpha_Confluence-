/**
 * The crypto package pulls in libsodium's WebAssembly (~1 MB). Loading it on
 * demand keeps it out of the sign-in page's bundle: it is fetched when keys
 * are first needed, and cached by the browser after that.
 */
import type * as Crypto from '@confluence/crypto';

export type E2E = typeof Crypto;

let loading: Promise<E2E> | null = null;

export function loadE2E(): Promise<E2E> {
  loading ??= import('@confluence/crypto');
  return loading;
}
