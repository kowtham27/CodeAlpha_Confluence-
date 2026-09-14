/**
 * The seam between the call UI and how media actually moves. Spec section 7:
 * a full mesh cannot scale past ~6 peers, so all peer-connection management
 * lives behind this interface. MeshTransport implements it today; an
 * SfuTransport can replace it without touching a single component.
 */

export type MediaKind = 'audio' | 'video';

/**
 * `session` identifies the sender's current set of connections. It changes
 * whenever a transport is recreated, which is how the far side learns that
 * an offer belongs to a new connection rather than the one it already has.
 */
export interface Signaling {
  sendDescription(to: string, session: string, description: RTCSessionDescriptionInit): void;
  sendCandidate(to: string, session: string, candidate: RTCIceCandidateInit | null): void;
}

export interface TransportEvents {
  /** A peer's media arrived, or its stream object was replaced by a rebuild. */
  onRemoteStream(peerId: string, stream: MediaStream): void;
  onPeerState(peerId: string, state: RTCPeerConnectionState): void;
}

export interface MediaTransport {
  /** Send this track to everyone (replaces any track of the same kind). */
  publish(track: MediaStreamTrack): Promise<void>;
  /** Stop sending this kind of media to everyone. */
  unpublish(kind: MediaKind): Promise<void>;
  /** Start exchanging media with a peer. Idempotent. */
  subscribe(peerId: string): void;
  unsubscribe(peerId: string): void;
  /** Feed signaling received from the server. */
  handleDescription(
    from: string,
    session: string,
    description: RTCSessionDescriptionInit,
  ): Promise<void>;
  handleCandidate(
    from: string,
    session: string,
    candidate: RTCIceCandidateInit | null,
  ): Promise<void>;
  /** Live connections, for diagnostics and tests. */
  peers(): ReadonlyMap<string, RTCPeerConnection>;
  close(): void;
}
