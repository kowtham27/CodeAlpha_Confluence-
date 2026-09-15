import pino from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Human-readable logs in development, if pino-pretty is installed. It is a
 * dev dependency: the production image does not have it (see the api-deps
 * stage in infra/Dockerfile) and logs JSON, even when run with a development
 * NODE_ENV as the local container stack is.
 */
function prettyAvailable(): boolean {
  if (isProduction) return false;
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

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
  ...(prettyAvailable()
    ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
    : {}),
});

export type Logger = typeof logger;
