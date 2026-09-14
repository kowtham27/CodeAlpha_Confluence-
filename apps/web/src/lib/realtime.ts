import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@confluence/shared';
import { useAuth } from '../stores/auth';
import { API_URL } from './api';
import { refreshAccessToken } from './session';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Opens the authenticated socket. The token is read through a callback, not
 * captured once, so every reconnect presents whatever token is current.
 */
export function connectRealtime(): AppSocket {
  const { setRealtime, signOut } = useAuth.getState();

  const socket: AppSocket = io(API_URL, {
    transports: ['websocket'],
    auth: (cb) => cb({ token: useAuth.getState().accessToken }),
  });

  setRealtime('connecting');
  socket.on('connect', () => setRealtime('online'));

  socket.on('connect_error', (error) => {
    setRealtime('offline');
    if (error.message === 'TOKEN_EXPIRED') {
      void refreshAccessToken().then((token) => {
        if (token) socket.connect();
      });
    }
  });

  socket.on('disconnect', (reason) => {
    setRealtime('offline');
    // The server only closes a socket deliberately when its session was
    // revoked: a logout elsewhere, "sign out everywhere", or reuse detection.
    if (reason === 'io server disconnect' && !useAuth.getState().signingOut) {
      signOut('You were signed out from another device.');
    }
  });

  return socket;
}
