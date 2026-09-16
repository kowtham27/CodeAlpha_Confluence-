import { env } from '../config/env.js';
import { parseAddress, type MailMessage, type Mailer } from './mailer.js';

/**
 * Sending through Gmail's HTTP API rather than SMTP. Same mailbox, same
 * limits (about 500 messages a day on a personal account), but it travels
 * over HTTPS, which hosts do not block: Render blocks outbound SMTP ports on
 * free services, so smtp.gmail.com is unreachable there.
 *
 * Authentication is OAuth: a refresh token, obtained once by the account
 * owner (pnpm gmail:auth), is exchanged for a short-lived access token as
 * needed. No password is stored, and the token can be revoked from the
 * Google account at any time.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TIMEOUT_MS = 15_000;

/** Non-ASCII headers must be encoded; ASCII ones are clearer left alone. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex -- the point is to find them
  if (!/[^\x00-\x7f]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Base64 in a message body is wrapped at 76 characters (RFC 2045). */
function base64Body(value: string): string {
  return (
    Buffer.from(value, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');
}

/**
 * The message as Gmail wants it: RFC 5322, with the plain-text and HTML
 * versions side by side so every client can read it.
 */
export function buildMimeMessage(from: string, message: MailMessage): string {
  const sender = parseAddress(from);
  const fromHeader = sender.name ? `${encodeHeader(sender.name)} <${sender.email}>` : sender.email;
  const boundary = `confluence-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return [
    `From: ${fromHeader}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Exchanges the refresh token for an access token, and keeps it until it is
 * nearly expired: Google issues them for an hour, and every exchange is a
 * network round trip in the path of a sign-up.
 */
/**
 * Google answers a mistyped credential with a bare "Bad Request", which says
 * nothing about which one. These shapes are stable, and checking them turns
 * the usual mistake -- a value clipped or quoted while being pasted into a
 * hosting dashboard -- into a message that names it.
 */
export function describeCredentialProblem(credentials: GmailCredentials): string | null {
  const { clientId, clientSecret, refreshToken } = credentials;
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    return `GMAIL_CLIENT_ID should end with .apps.googleusercontent.com (got ${clientId.length} characters)`;
  }
  if (clientSecret.length < 20) {
    return `GMAIL_CLIENT_SECRET looks incomplete (${clientSecret.length} characters, expected about 35)`;
  }
  if (!refreshToken.startsWith('1//')) {
    return 'GMAIL_REFRESH_TOKEN should start with "1//" — check it was pasted whole, without quotes';
  }
  if (refreshToken.length < 90) {
    return `GMAIL_REFRESH_TOKEN looks truncated (${refreshToken.length} characters, expected about 103): copy it from .env rather than a wrapped terminal line`;
  }
  return null;
}

export function createTokenSource(credentials: GmailCredentials): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;

  return async function accessToken(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt) return cached.token;

    const problem = describeCredentialProblem(credentials);
    if (problem) throw new Error(problem);

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as TokenResponse;

    if (!response.ok || !body.access_token) {
      // invalid_grant means the refresh token is gone: revoked, or expired
      // after seven days, which Google does to every unverified app. There
      // is no setting that avoids it: leaving "Testing" needs Google's
      // verification review of the app.
      const detail = body.error_description ?? body.error ?? `HTTP ${response.status}`;
      throw new Error(
        body.error === 'invalid_grant'
          ? `Gmail refused the refresh token (${detail}). Run pnpm gmail:auth again: Google expires these weekly while the OAuth app is unverified.`
          : `Gmail refused the credentials: ${detail}`,
      );
    }

    // A minute of slack, so a token cannot expire mid-request.
    const lifetimeMs = (body.expires_in ?? 3600) * 1000;
    cached = { token: body.access_token, expiresAt: Date.now() + lifetimeMs - 60_000 };
    return cached.token;
  };
}

export function createGmailMailer(credentials: GmailCredentials): Mailer {
  const accessToken = createTokenSource(credentials);

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${await accessToken()}`, ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  return {
    async send(message) {
      const raw = Buffer.from(buildMimeMessage(env.MAIL_FROM, message), 'utf8').toString(
        'base64url',
      );
      const response = await call(SEND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      if (!response.ok) {
        throw new Error(
          `Gmail rejected the message (${response.status}): ${await response.text()}`,
        );
      }
    },
    async verify() {
      // Only that the credentials still work: exchanging the refresh token
      // proves the client, the secret and the grant. Reading the mailbox
      // profile would need a scope this send-only grant deliberately lacks,
      // and Gmail answers that with 403 even when sending works.
      await accessToken();
    },
  };
}
