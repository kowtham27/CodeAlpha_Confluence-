/**
 * Authorises this app to send mail as you, once:
 *
 *   pnpm gmail:auth
 *
 * It opens Google's consent screen, catches the redirect on localhost, and
 * writes the refresh token into the root .env as GMAIL_REFRESH_TOKEN, having
 * first checked that Google accepts it. The grant can be revoked at any time
 * from https://myaccount.google.com/permissions
 *
 * Needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET from a Google Cloud OAuth
 * client (see DEPLOY.md). The client's redirect URI must include the address
 * below, exactly.
 */
/* eslint-disable no-console -- a command-line tool: the console is its output */

import { readFileSync, writeFileSync } from 'node:fs';
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

// Copying a 100-character secret out of a wrapped terminal line loses
// characters, and Google answers a truncated token with a bare "Bad
// Request". Write it to .env, and prove it works before saying so.
const envPath = fileURLToPath(new URL('../../../../.env', import.meta.url));
const line = `GMAIL_REFRESH_TOKEN=${body.refresh_token}`;
const current = readFileSync(envPath, 'utf8');
writeFileSync(
  envPath,
  /^GMAIL_REFRESH_TOKEN=.*$/m.test(current)
    ? current.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, line)
    : `${current.replace(/\n*$/, '\n')}${line}\n`,
);

// Spend the new token once, exactly as the API will. Done here with a plain
// request rather than by importing the mailer: this script runs before the
// environment it validates is complete.
const check = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: body.refresh_token,
    grant_type: 'refresh_token',
  }),
});
if (!check.ok) {
  const detail = (await check.json().catch(() => ({}))) as { error_description?: string };
  console.error('\nThe token was written to .env, but Google would not accept it:');
  console.error(`  ${detail.error_description ?? `HTTP ${check.status}`}`);
  process.exit(1);
}

console.log('\nDone, and checked against Google.');
console.log(`GMAIL_REFRESH_TOKEN written to ${envPath}`);
console.log('\nWhere the app is deployed, set:\n');
console.log('  MAIL_TRANSPORT=gmail');
console.log('  GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN');
console.log('\nCopy the token out of .env rather than this terminal: a wrapped line');
console.log('loses characters. It sends mail as you, so treat it as a password.');
console.log('Google expires it after 7 days while the app is unverified.\n');
process.exit(0);
