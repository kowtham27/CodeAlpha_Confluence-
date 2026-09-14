/**
 * The socket event contract. Both the server and the client import these maps,
 * so an event name can never drift between the two sides and a payload shape
 * can never be guessed. Spec section 2: no stringly-typed event names.
 *
 * Phases 2-6 add entries here FIRST, then implement against them.
 */
import type {
  Participant,
  PeerLeftReason,
  RoomJoinRequest,
  RoomJoinResult,
  RoomLeaveRequest,
  RoomSummary,
} from './schemas/room.js';
import type { AppError } from './types/result.js';

export const SOCKET_EVENTS = {
  // --- Phase 2: rooms & presence ---
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  /** Full snapshot of who is present, sent to a socket right after it joins. */
  ROOM_PARTICIPANTS: 'room:participants',
  ROOM_PEER_JOINED: 'room:peer-joined',
  ROOM_PEER_LEFT: 'room:peer-left',
  /** Lock state or name changed. */
  ROOM_UPDATED: 'room:updated',
  /** The owner ended the meeting; everyone is removed. */
  ROOM_ENDED: 'room:ended',
  /** This socket was replaced by the same user joining from elsewhere. */
  ROOM_DISPLACED: 'room:displaced',

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
 * Every client request carries an acknowledgement callback and gets exactly
 * one of these back, so the client always learns the outcome, including a
 * typed reason for a refusal (ROOM_FULL, ROOM_LOCKED...).
 */
export type Ack<T> = { ok: true; data: T } | { ok: false; error: AppError };
export type AckCallback<T> = (result: Ack<T>) => void;

/**
 * Events the client may emit. The server's typed Socket.IO instance is
 * parameterised by this map, so an unregistered event is a compile error
 * rather than a silently ignored message.
 */
export interface ClientToServerEvents {
  [SOCKET_EVENTS.ROOM_JOIN]: (payload: RoomJoinRequest, ack: AckCallback<RoomJoinResult>) => void;
  [SOCKET_EVENTS.ROOM_LEAVE]: (payload: RoomLeaveRequest, ack: AckCallback<null>) => void;
}

/** Events the server may emit to clients. */
export interface ServerToClientEvents {
  [SOCKET_EVENTS.ROOM_PARTICIPANTS]: (payload: {
    slug: string;
    participants: Participant[];
  }) => void;
  [SOCKET_EVENTS.ROOM_PEER_JOINED]: (payload: { slug: string; participant: Participant }) => void;
  [SOCKET_EVENTS.ROOM_PEER_LEFT]: (payload: {
    slug: string;
    userId: string;
    peerId: string;
    reason: PeerLeftReason;
  }) => void;
  /**
   * Only the fields that are the same for everyone. A full RoomSummary carries
   * `myRole`, which is per-user and must not be broadcast.
   */
  [SOCKET_EVENTS.ROOM_UPDATED]: (payload: Pick<RoomSummary, 'slug' | 'name' | 'isLocked'>) => void;
  [SOCKET_EVENTS.ROOM_ENDED]: (payload: { slug: string }) => void;
  [SOCKET_EVENTS.ROOM_DISPLACED]: (payload: { slug: string }) => void;
}

/** Per-connection state the server attaches after handshake auth. */
export interface SocketData {
  userId?: string;
  /** Refresh-token family id. Revoking the session disconnects its sockets. */
  sessionId?: string;
  displayName?: string;
  /** The one room this socket is in, if any. */
  roomSlug?: string;
}

/**
 * connect_error messages the handshake can produce. TOKEN_EXPIRED tells the
 * client to refresh and reconnect; anything else means sign in again.
 */
export const SOCKET_AUTH_ERRORS = ['UNAUTHENTICATED', 'TOKEN_EXPIRED'] as const;
export type SocketAuthError = (typeof SOCKET_AUTH_ERRORS)[number];
