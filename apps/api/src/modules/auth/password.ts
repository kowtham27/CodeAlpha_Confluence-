import { argon2id, hash, needsRehash, verify } from 'argon2';

/**
 * Spec: Argon2id, 64MB memory, 3 iterations. memoryCost is in KiB. Roughly
 * 250-300ms per hash on a laptop, which is the point: it makes offline
 * cracking of a leaked hash expensive and online guessing slow.
 */
const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed stored hash is a failed login, not a server error.
    return false;
  }
}

/** True when a stored hash predates the current parameters. */
export function isHashOutdated(passwordHash: string): boolean {
  return needsRehash(passwordHash, ARGON2_OPTIONS);
}

let equalizerHash: Promise<string> | undefined;

/**
 * Spends the same CPU as a real password check when there is no user to check
 * against. Without it, "unknown email" answers in ~5ms and "wrong password" in
 * ~280ms, and that timing gap tells an attacker which emails have accounts.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  equalizerHash ??= hashPassword('timing-equalizer: not a real credential');
  await verifyPassword(await equalizerHash, password);
}
