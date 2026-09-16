import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env.js';
import { iceServersFor, TURN_CREDENTIAL_TTL_SECONDS, turnCredentials } from './turn.js';

const secret = process.env['TURN_STATIC_AUTH_SECRET'] ?? '';

/**
 * Which relay is used is read from env at call time, so a test can put
 * Cloudflare's settings in place for one call. restoreMocks (vitest.config)
 * puts the real values back afterwards.
 */
/**
 * Overrides one setting for the length of a test. A plain vi.spyOn cannot:
 * an unset optional setting is absent from the object, not undefined on it.
 */
const originals = new Map<keyof typeof env, PropertyDescriptor | undefined>();

function stubEnv(key: keyof typeof env, value: string | undefined): void {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(env, key));
  Object.defineProperty(env, key, { value, configurable: true, enumerable: true, writable: true });
}

afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(env, key, descriptor);
    else delete (env as Record<string, unknown>)[key];
  }
  originals.clear();
});

function withCloudflareConfigured(): void {
  stubEnv('CLOUDFLARE_TURN_TOKEN_ID', 'token-id');
  stubEnv('CLOUDFLARE_TURN_API_TOKEN', 'api-token');
}

/**
 * The developer's own .env may configure a hosted relay. These tests are
 * about the local coturn path, so they say so rather than depending on
 * whoever runs them (and never call a real TURN service).
 */
function withLocalCoturnOnly(): void {
  stubEnv('CLOUDFLARE_TURN_TOKEN_ID', undefined);
  stubEnv('CLOUDFLARE_TURN_API_TOKEN', undefined);
  stubEnv('TURN_URLS', undefined);
}

describe('TURN credentials (coturn use-auth-secret)', () => {
  it('uses "<expiry>:<userId>" with a 12-hour expiry', () => {
    const now = Date.UTC(2026, 8, 15, 12, 0, 0);
    const { username } = turnCredentials('user_1', now);
    const [expiry, user] = username.split(':');

    expect(user).toBe('user_1');
    expect(Number(expiry)).toBe(now / 1000 + TURN_CREDENTIAL_TTL_SECONDS);
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
    expect(turnCredentials('a', now).username).not.toBe(turnCredentials('b', now).username);
  });

  it('offers STUN, then TURN over UDP and TCP, credentials only on TURN', async () => {
    withLocalCoturnOnly();

    const [stun, turn] = await iceServersFor('user_1');

    expect(stun).toEqual({ urls: expect.stringMatching(/^stun:[^:]+:\d+$/) as unknown });
    expect(turn?.urls).toEqual([
      expect.stringMatching(/^turn:.+\?transport=udp$/) as unknown,
      expect.stringMatching(/^turn:.+\?transport=tcp$/) as unknown,
    ]);
    expect(turn?.username).toMatch(/^\d+:user_1$/);
    expect(turn?.credential).toBeTruthy();
  });
});

describe('Cloudflare Realtime TURN', () => {
  const cloudflareServers = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'cf-user',
      credential: 'cf-credential',
    },
  ];

  function mockFetch(response: Response) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  }

  it('asks Cloudflare for credentials, and keeps the API token on the server', async () => {
    withCloudflareConfigured();
    const fetchMock = mockFetch(
      new Response(JSON.stringify({ iceServers: cloudflareServers }), { status: 201 }),
    );

    const servers = await iceServersFor('user_1');

    expect(servers).toEqual(cloudflareServers);
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    // fetch takes a string, a URL, or a Request.
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : (url?.url ?? '');
    expect(target).toContain('/credentials/generate-ice-servers');
    expect(options?.method).toBe('POST');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer api-token' });
    // Whatever Cloudflare returns goes to the browser; the token never does.
    expect(JSON.stringify(servers)).not.toContain('api-token');
  });

  it('falls back to coturn when Cloudflare fails, so a call can still start', async () => {
    withLocalCoturnOnly();
    withCloudflareConfigured();
    mockFetch(new Response('nope', { status: 500 }));

    const [stun, turn] = await iceServersFor('user_1');

    expect(stun?.urls).toMatch(/^stun:/);
    expect(turn?.username).toMatch(/^\d+:user_1$/);
  });
});
