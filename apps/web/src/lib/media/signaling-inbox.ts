import type { IceCandidate, SessionDescription } from '@confluence/shared';
import type { AppSocket } from '../realtime';

/**
 * Holds WebRTC signaling that arrives before anything can handle it.
 *
 * When someone joins, the people already in the room react to peer-joined by
 * sending offers at once, and those can arrive before the newcomer's call
 * transport exists (it is created when the call UI mounts, after the join
 * ack). A lost offer is a pair that never connects: the offerer waits for an
 * answer that never comes. So signaling is received from the moment the
 * socket exists, and queued until a transport takes over.
 */

export type SignalMessage =
  | { kind: 'description'; from: string; session: string; description: SessionDescription }
  | { kind: 'candidate'; from: string; session: string; candidate: IceCandidate | null };

/** Queued signaling older than this belongs to a call that has moved on. */
const MAX_AGE_MS = 15_000;
const MAX_QUEUED = 500;

export class SignalingInbox {
  private queue: { at: number; message: SignalMessage }[] = [];
  private consumer: ((message: SignalMessage) => void) | null = null;

  constructor(socket: AppSocket) {
    const description = (p: { from: string; session: string; description: SessionDescription }) =>
      this.push({ kind: 'description', ...p });
    socket.on('webrtc:offer', description);
    socket.on('webrtc:answer', description);
    socket.on('webrtc:ice-candidate', (p) => this.push({ kind: 'candidate', ...p }));
  }

  private push(message: SignalMessage): void {
    if (this.consumer) {
      this.consumer(message);
      return;
    }
    this.queue.push({ at: Date.now(), message });
    if (this.queue.length > MAX_QUEUED) this.queue.shift();
  }

  /** Delivers the recent backlog in order, then everything live. Returns detach. */
  attach(consumer: (message: SignalMessage) => void): () => void {
    this.consumer = consumer;
    const fresh = Date.now() - MAX_AGE_MS;
    const backlog = this.queue.filter((q) => q.at >= fresh);
    this.queue = [];
    for (const { message } of backlog) consumer(message);
    return () => {
      if (this.consumer === consumer) this.consumer = null;
    };
  }
}

const inboxes = new WeakMap<AppSocket, SignalingInbox>();

/** The socket's inbox, created with the socket (see connectRealtime). */
export function signalingInbox(socket: AppSocket): SignalingInbox {
  let inbox = inboxes.get(socket);
  if (!inbox) {
    inbox = new SignalingInbox(socket);
    inboxes.set(socket, inbox);
  }
  return inbox;
}
