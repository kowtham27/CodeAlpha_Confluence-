/**
 * The socket event contract. Both the server and the client import these maps,
 * so an event name can never drift between the two sides and a payload shape
 * can never be guessed. Spec section 2: no stringly-typed event names.
 *
 * Phases 2-6 add entries here FIRST, then implement against them.
 */

export const SOCKET_EVENTS = {
  // --- Phase 2: rooms & presence ---
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  ROOM_PARTICIPANTS: 'room:participants',
  ROOM_PEER_JOINED: 'room:peer-joined',
  ROOM_PEER_LEFT: 'room:peer-left',

  // --- Phase 3: WebRTC signaling (always addressed to one peer) ---
  WEBRTC_OFFER: 'webrtc:offer',
  WEBRTC_ANSWER: 'webrtc:answer',
  WEBRTC_ICE_CANDIDATE: 'webrtc:ice-candidate',

  // --- Phase 4: screen share lock ---
  SCREEN_CLAIM: 'screen:claim',
  SCREEN_RELEASE: 'screen:release',
  SCREEN_STATE: 'screen:state',

  // --- Phase 5: files ---
  FILE_SHARED: 'file:shared',

  // --- Phase 6: whiteboard ---
  BOARD_OP: 'board:op',
  BOARD_ACK: 'board:ack',
  BOARD_SNAPSHOT: 'board:snapshot',

  // --- Cross-cutting ---
  ERROR: 'app:error',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

/**
 * Events the client may emit. Populated per phase; the server's typed
 * Socket.IO instance is parameterised by this map, so an unregistered event
 * is a compile error rather than a silently ignored message.
 */
export interface ClientToServerEvents {
  // Phase 2 onward.
  [key: string]: never;
}

/** Events the server may emit to clients. */
export interface ServerToClientEvents {
  [key: string]: never;
}

/** Per-connection state the server attaches after handshake auth. */
export interface SocketData {
  userId?: string;
  /** Refresh-token family id. Revoking the session disconnects its sockets. */
  sessionId?: string;
  roomSlug?: string;
}

/**
 * connect_error messages the handshake can produce. TOKEN_EXPIRED tells the
 * client to refresh and reconnect; anything else means sign in again.
 */
export const SOCKET_AUTH_ERRORS = ['UNAUTHENTICATED', 'TOKEN_EXPIRED'] as const;
export type SocketAuthError = (typeof SOCKET_AUTH_ERRORS)[number];
