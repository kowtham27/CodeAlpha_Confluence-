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
}

/**
 * Populated only by the 'memory' transport, which tests select via
 * MAIL_TRANSPORT. Lets an integration test read the verification link out of
 * the "email" without an SMTP server.
 */
export const memoryOutbox: MailMessage[] = [];

function createMailer(): Mailer {
  if (env.MAIL_TRANSPORT === 'memory') {
    return {
      send: (message) => {
        memoryOutbox.push(message);
        return Promise.resolve();
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
  });

  return {
    async send(message) {
      await transport.sendMail({ from: env.MAIL_FROM, ...message });
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
