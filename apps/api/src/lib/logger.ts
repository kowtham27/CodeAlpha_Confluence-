import pino from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Spec section 5: never log tokens, passwords, message contents, or file bytes.
 * Redaction is enforced here rather than left to per-call-site discipline.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'token',
      '*.token',
      'refreshToken',
      '*.refreshToken',
      'ciphertext',
      '*.ciphertext',
      'encryptedPrivateKey',
      '*.encryptedPrivateKey',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }),
});

export type Logger = typeof logger;
