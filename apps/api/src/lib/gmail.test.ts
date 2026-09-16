import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMimeMessage,
  createGmailMailer,
  createTokenSource,
  describeCredentialProblem,
} from './gmail.js';

const message = {
  to: 'someone@example.com',
  subject: 'Verify your email for Confluence',
  text: 'Confirm this is your email address.',
  html: '<p>Confirm this is your email address.</p>',
};

/** The body of a base64 part, decoded. */
function part(mime: string, contentType: string): string {
  const section = mime.split('--').find((s) => s.includes(contentType));
  const body = section?.split('\r\n\r\n')[1]?.trim().replace(/\r\n/g, '') ?? '';
  return Buffer.from(body, 'base64').toString('utf8');
}

describe('buildMimeMessage', () => {
  it('carries the sender, recipient and subject', () => {
    const mime = buildMimeMessage('Confluence <hi@example.com>', message);

    expect(mime).toContain('From: Confluence <hi@example.com>');
    expect(mime).toContain('To: someone@example.com');
    expect(mime).toContain('Subject: Verify your email for Confluence');
  });

  it('sends the text and HTML versions side by side, both readable', () => {
    const mime = buildMimeMessage('Confluence <hi@example.com>', message);
    const boundary = /boundary="([^"]+)"/.exec(mime)?.[1];

    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(boundary).toBeTruthy();
    expect(mime.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    expect(part(mime, 'text/plain')).toBe(message.text);
    expect(part(mime, 'text/html')).toBe(message.html);
  });

  it('encodes a non-ASCII subject or name, which a raw header cannot hold', () => {
    const mime = buildMimeMessage('Café <hi@example.com>', { ...message, subject: 'Vérifiez' });

    expect(mime).toContain('=?UTF-8?B?');
    expect(mime).not.toContain('Subject: Vérifiez');
    // The encoded word decodes back to what was asked for.
    const encoded = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(mime)?.[1] ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('Vérifiez');
  });

  it('uses CRLF line endings and a fresh boundary each time, as the format requires', () => {
    const first = buildMimeMessage('Confluence <hi@example.com>', message);
    const second = buildMimeMessage('Confluence <hi@example.com>', message);

    expect(first).toContain('\r\n');
    expect(/boundary="([^"]+)"/.exec(first)?.[1]).not.toBe(/boundary="([^"]+)"/.exec(second)?.[1]);
  });
});

describe('access tokens', () => {
  // Shaped like the real thing: the token source checks before it asks Google.
  const credentials = {
    clientId: '357710013194-abc.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-0123456789abcdefghijklmn',
    refreshToken: `1//0${'a'.repeat(99)}`,
  };

  afterEach(() => vi.restoreAllMocks());

  // A Response body can only be read once, so each call gets its own.
  function mockToken(body: unknown, status = 200) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  }

  it('reuses a token until it is nearly expired, instead of asking every time', async () => {
    const fetchMock = mockToken({ access_token: 'first', expires_in: 3600 });
    const accessToken = createTokenSource(credentials);

    expect(await accessToken()).toBe('first');
    expect(await accessToken()).toBe('first');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again once the token has expired', async () => {
    // expires_in below the minute of slack: already due for renewal.
    const fetchMock = mockToken({ access_token: 'short', expires_in: 10 });
    const accessToken = createTokenSource(credentials);

    await accessToken();
    await accessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('explains an expired grant, which Google does weekly to an unverified app', async () => {
    mockToken({ error: 'invalid_grant', error_description: 'Token has been expired' }, 400);
    const accessToken = createTokenSource(credentials);

    await expect(accessToken()).rejects.toThrow(/gmail:auth again.*unverified/s);
  });

  it('reports any other refusal with what Google said', async () => {
    mockToken({ error: 'invalid_client', error_description: 'Unauthorized' }, 401);
    const accessToken = createTokenSource(credentials);

    await expect(accessToken()).rejects.toThrow(/Unauthorized/);
  });
});

describe('describeCredentialProblem', () => {
  const good = {
    clientId: '357710013194-abc.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-0123456789abcdefghijklmn',
    refreshToken: `1//0${'a'.repeat(99)}`,
  };

  it('passes a well-formed set', () => {
    expect(describeCredentialProblem(good)).toBeNull();
  });

  it('names a token clipped by a wrapped terminal line, the usual mistake', () => {
    const problem = describeCredentialProblem({ ...good, refreshToken: `1//0${'a'.repeat(60)}` });

    expect(problem).toMatch(/GMAIL_REFRESH_TOKEN looks truncated \(64 characters/);
  });

  it('names a value pasted with quotes, and a wrong client id or secret', () => {
    expect(describeCredentialProblem({ ...good, refreshToken: `"1//0${'a'.repeat(99)}"` })).toMatch(
      /should start with "1\/\/"/,
    );
    expect(describeCredentialProblem({ ...good, clientId: '357710013194' })).toMatch(
      /GMAIL_CLIENT_ID/,
    );
    expect(describeCredentialProblem({ ...good, clientSecret: 'GOCSPX-short' })).toMatch(
      /GMAIL_CLIENT_SECRET looks incomplete/,
    );
  });
});

describe('verify', () => {
  it('checks the credentials without reading the mailbox, which send-only cannot', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }))),
      );

    await createGmailMailer({
      clientId: '357710013194-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-0123456789abcdefghijklmn',
      refreshToken: `1//0${'a'.repeat(99)}`,
    }).verify();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(typeof url === 'string' ? url : '').toBe('https://oauth2.googleapis.com/token');
  });
});
