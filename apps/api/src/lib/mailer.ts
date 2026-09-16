import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  /** Connects and authenticates without sending, for the health check. */
  verify(): Promise<void>;
}

/** Shown as the sender when MAIL_FROM carries an address but no name. */
const DEFAULT_SENDER_NAME = 'Confluence';

/**
 * "Confluence <hi@example.com>" -> the two parts an email API wants.
 *
 * The whole value may arrive wrapped in quotes: .env files use them to keep
 * the spaces, and dotenv strips them, but a hosting dashboard stores exactly
 * what was pasted, quotes included. Strip them here rather than sending
 * `"Confluence <hi@example.com>"` to a provider as an address.
 */
export function parseAddress(value: string): { name: string; email: string } {
  const unquoted = value.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(unquoted);
  if (match?.[2]) {
    return { name: match[1]?.replace(/^"|"$/g, '').trim() ?? '', email: match[2].trim() };
  }
  return { name: '', email: unquoted.trim() };
}

/**
 * Populated only by the 'memory' transport, which tests select via
 * MAIL_TRANSPORT. Lets an integration test read the verification link out of
 * the "email" without an SMTP server.
 */
export const memoryOutbox: MailMessage[] = [];

/** Where email goes, for logs and the test-email script. */
export const mailDestination =
  env.MAIL_TRANSPORT === 'memory'
    ? 'memory (tests)'
    : env.MAIL_TRANSPORT === 'brevo'
      ? 'the Brevo API over HTTPS (real email)'
      : env.SMTP_HOST
        ? `${env.SMTP_HOST}:${env.SMTP_PORT} (real email)`
        : `Mailpit at ${env.MAILPIT_HOST}:1025 (read it at http://localhost:8025)`;

/**
 * Brevo's HTTP API, for hosts that block outbound SMTP: Render blocks ports
 * 25, 465 and 587 on free services, so smtp.gmail.com simply times out
 * there. HTTPS is never blocked, and the same account sends the mail.
 */
function createBrevoMailer(apiKey: string): Mailer {
  const parsed = parseAddress(env.MAIL_FROM);
  // Brevo rejects an empty name outright ("sender name is missing"), so an
  // address with no name still gets one.
  const sender = { email: parsed.email, name: parsed.name || DEFAULT_SENDER_NAME };

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`https://api.brevo.com/v3${path}`, {
      ...init,
      headers: { 'api-key': apiKey, accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
  }

  return {
    async send(message) {
      const response = await call('/smtp/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sender,
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
          htmlContent: message.html,
        }),
      });
      if (!response.ok) {
        // The body names the cause: an unverified sender, or a spent quota.
        throw new Error(
          `Brevo rejected the message (${response.status}): ${await response.text()}`,
        );
      }
    },
    async verify() {
      const response = await call('/account');
      if (!response.ok) {
        throw new Error(`Brevo rejected the API key (${response.status})`);
      }
    },
  };
}

function createTransport() {
  if (!env.SMTP_HOST) {
    // The local sink: no TLS, no login, nothing leaves the machine.
    return nodemailer.createTransport({ host: env.MAILPIT_HOST, port: 1025, secure: false });
  }
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    // On 587 the connection starts plain and upgrades: insist on the upgrade,
    // so a password and reset links never cross the network unencrypted.
    requireTLS: !env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
  });
}

function createMailer(): Mailer {
  if (env.MAIL_TRANSPORT === 'brevo') {
    logger.info({ mail: mailDestination }, 'email delivery');
    return createBrevoMailer(env.BREVO_API_KEY ?? '');
  }

  if (env.MAIL_TRANSPORT === 'memory') {
    return {
      send: (message) => {
        memoryOutbox.push(message);
        return Promise.resolve();
      },
      verify: () => Promise.resolve(),
    };
  }

  const transport = createTransport();
  logger.info({ mail: mailDestination }, 'email delivery');
  // Sign-up mail is sent in the background, so a wrong password would only
  // show up in the logs at the first sign-up. Check the login now instead.
  if (env.SMTP_HOST) {
    transport.verify().catch((error: unknown) => {
      logger.error({ err: error }, 'SMTP login failed: emails will not be delivered');
    });
  }

  return {
    async send(message) {
      await transport.sendMail({ from: env.MAIL_FROM, ...message });
    },
    async verify() {
      await transport.verify();
    },
  };
}

export const mailer = createMailer();

/**
 * Sends without making the caller wait. Registration uses this so a slow SMTP
 * server cannot add latency, and so the response time does not differ between
 * "new account" and "already registered" (which would leak which is which).
 */
export function sendInBackground(message: MailMessage): void {
  mailer.send(message).catch((error: unknown) => {
    // The recipient is PII; the subject identifies the flow well enough.
    logger.error({ err: error, subject: message.subject }, 'failed to send email');
  });
}
