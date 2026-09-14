import { EventEmitter } from 'node:events';

/**
 * Lets the auth module announce revoked sessions without importing Socket.IO.
 * server.ts subscribes and disconnects the affected sockets, which keeps the
 * HTTP layer testable on its own.
 */
export interface AuthEvents {
  'sessions-revoked': [payload: { userId: string; sessionIds: string[] }];
}

export const authEvents = new EventEmitter<AuthEvents>();
