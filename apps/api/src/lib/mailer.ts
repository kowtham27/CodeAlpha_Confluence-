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
    : env.SMTP_HOST
      ? `${env.SMTP_HOST}:${env.SMTP_PORT} (real email)`
      : `Mailpit at ${env.MAILPIT_HOST}:1025 (read it at http://localhost:8025)`;

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
