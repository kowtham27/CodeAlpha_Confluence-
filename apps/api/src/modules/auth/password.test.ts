import { describe, expect, it } from 'vitest';
import { argon2Params } from '../../../test/argon2.js';
import { hashPassword, isHashOutdated, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('uses argon2id with the specced cost', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(argon2Params(hash)).toEqual({ algorithm: 'argon2id', m: 65536, t: 3, p: 1 });
    expect(isHashOutdated(hash)).toBe(false);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
  });

  it('salts: the same password never hashes the same twice', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('treats a corrupt stored hash as a failed login, not a crash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('flags hashes made with weaker parameters for upgrade', () => {
    const weak =
      '$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$' +
      'R6sPg4CZmHnuGTxwYbGzIzLWQYyr0Ew0KxHn3E1HD+0';
    expect(isHashOutdated(weak)).toBe(true);
  });
});
