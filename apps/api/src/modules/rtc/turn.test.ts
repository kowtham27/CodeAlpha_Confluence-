import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { iceServersFor, TURN_CREDENTIAL_TTL_SECONDS, turnCredentials } from './turn.js';

const secret = process.env['TURN_STATIC_AUTH_SECRET'] ?? '';

describe('TURN credentials (coturn use-auth-secret)', () => {
  it('uses "<expiry>:<userId>" with a 12-hour expiry', () => {
    const now = Date.UTC(2026, 8, 15, 12, 0, 0);
    const { username } = turnCredentials('user_1', now);
    const [expiry, user] = username.split(':');
    expect(user).toBe('user_1');
    expect(Number(expiry)).toBe(now / 1000 + 12 * 60 * 60);
    expect(TURN_CREDENTIAL_TTL_SECONDS).toBe(43_200);
  });

  it('signs the username with HMAC-SHA1 of the shared secret, base64', () => {
    const { username, credential } = turnCredentials('user_1');
    // Recompute exactly as coturn does.
    expect(credential).toBe(createHmac('sha1', secret).update(username).digest('base64'));
  });

  it('differs per user, so one user cannot reuse another user credential', () => {
    const now = Date.now();
    expect(turnCredentials('a', now).credential).not.toBe(turnCredentials('b', now).credential);
  });

  it('offers STUN, then TURN over UDP and TCP, credentials only on TURN', () => {
    const [stun, turn] = iceServersFor('user_1');
    expect(stun).toEqual({ urls: expect.stringMatching(/^stun:[^:]+:\d+$/) as unknown });
    expect(turn?.urls).toEqual([
      expect.stringMatching(/^turn:.+\?transport=udp$/) as unknown,
      expect.stringMatching(/^turn:.+\?transport=tcp$/) as unknown,
    ]);
    expect(turn?.username).toMatch(/^\d+:user_1$/);
    expect(turn?.credential).toBeTruthy();
  });
});
