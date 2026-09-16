/**
 * Authorises this app to send mail as you, once:
 *
 *   pnpm gmail:auth
 *
 * It opens Google's consent screen, catches the redirect on localhost, and
 * prints the refresh token to paste into GMAIL_REFRESH_TOKEN. Nothing is
 * stored by the script, and the grant can be revoked at any time from
 * https://myaccount.google.com/permissions
 *
 * Needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET from a Google Cloud OAuth
 * client (see DEPLOY.md). The client's redirect URI must include the address
 * below, exactly.
 */
/* eslint-disable no-console -- a command-line tool: the console is its output */

import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

// The same root .env the API reads. Not via config/env.ts: that validates
// every setting, and this script needs two of them, before the rest exist.
loadDotenv({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });

const PORT = 5599;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
// Send-only: this grant cannot read the mailbox.
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const clientId = process.env['GMAIL_CLIENT_ID'];
const clientSecret = process.env['GMAIL_CLIENT_SECRET'];

if (!clientId || !clientSecret) {
  console.error(
    'Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first (in .env, or on the command line).\n' +
      'They come from a Google Cloud OAuth client: see DEPLOY.md, "Email that a free host can send".',
  );
  process.exit(1);
}

const consentUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  // offline + consent: without both, Google returns no refresh token on a
  // repeat authorisation.
  access_type: 'offline',
  prompt: 'consent',
}).toString()}`;

/** Waits for Google to redirect back with the one-time code. */
function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<body style="font:16px system-ui;padding:3rem;text-align:center">${
          code
            ? 'Authorised. Close this tab and go back to the terminal.'
            : `Failed: ${error ?? 'no code'}`
        }</body>`,
      );
      server.close();
      if (code) resolve(code);
      else reject(new Error(error ?? 'Google returned no authorisation code'));
    });
    server.listen(PORT);
    server.on('error', reject);
  });
}

console.log(`\nOpen this in the browser signed in as the sending account:\n\n${consentUrl}\n`);
console.log('Google will warn that the app is unverified: choose Advanced, then continue.');
console.log('If it says "Access blocked", the account is not a Test user on the OAuth app yet.');
console.log(`Waiting for the redirect to ${REDIRECT_URI} ...`);

// Best effort: open it for them. No shell, so the URL is an argument rather
// than something a command line has to quote.
const opener =
  process.platform === 'win32'
    ? 'explorer.exe'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
try {
  const { spawn } = await import('node:child_process');
  spawn(opener, [consentUrl], { stdio: 'ignore', detached: true }).unref();
} catch {
  // The printed URL is the real interface; opening it is a convenience.
}

const code = await Promise.race([
  waitForCode(),
  delay(5 * 60_000).then(() => {
    throw new Error('Timed out after five minutes');
  }),
]);

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }),
});
const body = (await response.json()) as { refresh_token?: string; error_description?: string };

if (!response.ok || !body.refresh_token) {
  console.error(`\nGoogle refused: ${body.error_description ?? `HTTP ${response.status}`}`);
  console.error('If it mentions redirect_uri, add exactly this one to the OAuth client:');
  console.error(`  ${REDIRECT_URI}`);
  process.exit(1);
}

console.log('\nDone. Set these three where the app runs:\n');
console.log('  MAIL_TRANSPORT=gmail');
console.log(`  GMAIL_REFRESH_TOKEN=${body.refresh_token}`);
console.log('  (plus GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET, as used here)\n');
console.log('Treat the refresh token like a password: it can send mail as you.');
console.log('Google expires it after 7 days while the app is unverified: run this again then.\n');
process.exit(0);
