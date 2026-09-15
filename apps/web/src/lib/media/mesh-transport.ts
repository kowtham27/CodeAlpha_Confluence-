import type { MediaKind, MediaTransport, Signaling, TransportEvents } from './transport';

/** Spec: on 'disconnected', wait this long, then restart ICE. */
const ICE_RESTART_DELAY_MS = 3_000;

interface PeerLink {
  pc: RTCPeerConnection;
  /**
   * Perfect negotiation roles. The peer with the smaller id is impolite: it
   * starts the negotiation (spec: deterministic offer initiation) and wins
   * any collision. The polite peer rolls back its own offer instead.
   */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  remoteStream: MediaStream;
  /** The far side's session, learned from its first description. */
  remoteSession: string | null;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** Direct file transfers; see openFilesChannel. */
  files: RTCDataChannel | null;
}

/**
 * Full-mesh WebRTC: one RTCPeerConnection per other participant.
 *
 * Every connection is created with exactly one audio and one video
 * transceiver, both sendrecv, from the first negotiation. Publishing,
 * muting a device away, switching camera, and (Phase 4) screen sharing are
 * all `sender.replaceTrack()`: no renegotiation, no new offer, no glare. It
 * also means a participant who has no camera, or denied permission, still
 * receives everyone else, because the transceivers exist regardless.
 */
export class MeshTransport implements MediaTransport {
  private readonly links = new Map<string, PeerLink>();
  /**
   * Signaling for one peer is handled strictly in order. Without this, an ICE
   * candidate that arrives while the offer is still being applied would hit
   * addIceCandidate before setRemoteDescription finished, and be lost.
   * Keyed by peer, not stored on the link: a rebuild replaces the link midway
   * through a task, and the candidates that follow must still wait for it.
   */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly local: Record<MediaKind, MediaStreamTrack | null> = { audio: null, video: null };
  private closed = false;
  /** Sent with every signaling message; see Signaling. */
  readonly session = crypto.randomUUID();

  constructor(
    private readonly selfId: string,
    private readonly iceServers: RTCIceServer[],
    private readonly signaling: Signaling,
    private readonly events: TransportEvents,
  ) {}

  // ---- publishing -----------------------------------------------------------

  async publish(track: MediaStreamTrack): Promise<void> {
    const kind = track.kind as MediaKind;
    this.local[kind] = track;
    await Promise.all([...this.links.values()].map((link) => this.setSender(link, kind, track)));
  }

  async unpublish(kind: MediaKind): Promise<void> {
    this.local[kind] = null;
    await Promise.all([...this.links.values()].map((link) => this.setSender(link, kind, null)));
  }

  private async setSender(link: PeerLink, kind: MediaKind, track: MediaStreamTrack | null) {
    const transceiver = transceiverFor(link.pc, kind);
    // The polite side has no transceivers until the first offer arrives; the
    // current local tracks are attached then (see attachLocalTracks).
    if (!transceiver || link.pc.signalingState === 'closed') return;
    if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track);
  }

  // ---- peers ------------------------------------------------------------------

  subscribe(peerId: string): void {
    if (this.closed || peerId === this.selfId || this.links.has(peerId)) return;
    const link = this.createLink(peerId);
    if (!link.polite) this.startNegotiation(peerId, link);
  }

  unsubscribe(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    clearTimeout(link.restartTimer);
    link.pc.close();
  }

  /** Forget a peer entirely, including queued signaling. */
  private forget(peerId: string): void {
    this.unsubscribe(peerId);
    this.queues.delete(peerId);
  }

  peers(): ReadonlyMap<string, RTCPeerConnection> {
    return new Map([...this.links].map(([id, link]) => [id, link.pc]));
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.links.keys()]) this.forget(id);
  }

  private createLink(peerId: string): PeerLink {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const link: PeerLink = {
      pc,
      polite: this.selfId > peerId,
      makingOffer: false,
      ignoreOffer: false,
      remoteStream: new MediaStream(),
      remoteSession: null,
      restartTimer: undefined,
      files: null,
    };
    this.links.set(peerId, link);
    // A closed or rebuilt connection can still fire events for a moment; only
    // the peer's current link may touch the UI or trigger a rebuild.
    const current = (): boolean => this.links.get(peerId) === link;

    pc.onicecandidate = ({ candidate }) => {
      this.signaling.sendCandidate(peerId, this.session, candidate ? candidate.toJSON() : null);
    };

    pc.ontrack = ({ track }) => {
      if (!current()) return;
      if (!link.remoteStream.getTracks().includes(track)) link.remoteStream.addTrack(track);
      this.events.onRemoteStream(peerId, link.remoteStream);
    };

    // Perfect negotiation, MDN's pattern. Fires for the impolite side's
    // initial transceivers, and for either side on restartIce().
    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.signaling.sendDescription(peerId, this.session, pc.localDescription.toJSON());
        }
      } catch (error) {
        console.warn('negotiation failed', peerId, error);
      } finally {
        link.makingOffer = false;
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (!current()) return;
      const state = pc.iceConnectionState;
      if (state === 'disconnected') {
        // Often a blip (Wi-Fi roam, brief loss). Give it 3s to recover on its
        // own, then restart ICE with fresh candidates. Spec behaviour.
        clearTimeout(link.restartTimer);
        link.restartTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') pc.restartIce();
        }, ICE_RESTART_DELAY_MS);
      } else if (state === 'failed') {
        // Spec: tear the connection down and build a new one. The impolite
        // side re-offers; the polite side waits for that offer.
        clearTimeout(link.restartTimer);
        this.rebuild(peerId);
      } else if (state === 'connected' || state === 'completed') {
        clearTimeout(link.restartTimer);
      }
    };

    pc.onconnectionstatechange = () => {
      if (current()) this.events.onPeerState(peerId, pc.connectionState);
    };
    return link;
  }

  /**
   * Impolite side only: create the two transceivers and the data channel,
   * which together trigger the one and only offer.
   */
  private startNegotiation(peerId: string, link: PeerLink): void {
    for (const kind of ['audio', 'video'] as const) {
      link.pc.addTransceiver(this.local[kind] ?? kind, { direction: 'sendrecv' });
    }
    this.openFilesChannel(peerId, link);
  }

  /**
   * A pre-negotiated channel (both sides create id 0 themselves; nothing is
   * announced in-band). The impolite side creates it before its offer, so the
   * offer includes a data section; the polite side creates it when that offer
   * arrives, so its answer accepts it. Either way there is no extra
   * negotiation. Encrypted end to end by DTLS, like the media.
   */
  private openFilesChannel(peerId: string, link: PeerLink): void {
    if (link.files) return;
    link.files = link.pc.createDataChannel('files', { negotiated: true, id: 0, ordered: true });
    this.events.onDataChannel(peerId, link.files);
  }

  private rebuild(peerId: string): PeerLink | undefined {
    if (this.closed) return undefined;
    this.unsubscribe(peerId);
    const link = this.createLink(peerId);
    if (!link.polite) this.startNegotiation(peerId, link);
    return link;
  }

  /**
   * Polite side, on receiving an offer: the offer created our transceivers
   * as recvonly. Make them sendrecv and attach whatever we are publishing, so
   * the answer carries our media without a second round trip.
   */
  private async attachLocalTracks(link: PeerLink): Promise<void> {
    for (const transceiver of link.pc.getTransceivers()) {
      const kind = transceiver.receiver.track.kind as MediaKind;
      if (transceiver.direction !== 'sendrecv') transceiver.direction = 'sendrecv';
      const track = this.local[kind];
      if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track);
    }
  }

  // ---- incoming signaling -------------------------------------------------------

  handleDescription(
    from: string,
    session: string,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    return this.enqueue(from, async (existing) => {
      let link = existing;
      // The far side replaced its connection (new session), or ours is dead:
      // rebuild to match instead of applying a stranger's SDP to the old one,
      // which leaves media half-working (the DTLS identity has changed).
      const replaced = link.remoteSession !== null && link.remoteSession !== session;
      const dead =
        description.type === 'offer' &&
        (link.pc.connectionState === 'failed' || link.pc.signalingState === 'closed');
      if (replaced || dead) {
        link = this.rebuild(from) ?? link;
        // An answer from a session we never offered to is meaningless; the
        // rebuild re-offers if it is our turn.
        if (description.type === 'answer') return;
      }
      const { pc } = link;

      const collision =
        description.type === 'offer' && (link.makingOffer || pc.signalingState !== 'stable');
      link.ignoreOffer = !link.polite && collision;
      if (link.ignoreOffer) return;

      // On a collision the polite side's setRemoteDescription implicitly rolls
      // back its own pending offer (rollback is built into modern browsers).
      await pc.setRemoteDescription(description);
      link.remoteSession = session;
      if (description.type === 'offer') {
        // Between applying the offer and answering: the answer then accepts
        // the offer's data section, and no renegotiation is needed.
        this.openFilesChannel(from, link);
        await this.attachLocalTracks(link);
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.signaling.sendDescription(from, this.session, pc.localDescription.toJSON());
        }
      }
    });
  }

  handleCandidate(
    from: string,
    session: string,
    candidate: RTCIceCandidateInit | null,
  ): Promise<void> {
    return this.enqueue(from, async (link) => {
      // Left over from a connection the far side has since replaced.
      if (link.remoteSession !== null && link.remoteSession !== session) return;
      try {
        await link.pc.addIceCandidate(candidate ?? undefined);
      } catch (error) {
        // Candidates for an offer we deliberately ignored are expected to fail.
        if (!link.ignoreOffer) console.warn('addIceCandidate failed', from, error);
      }
    });
  }

  /**
   * Runs `task` after every earlier signaling task for this peer. Signaling
   * can arrive before our own participant list knows the peer (the server
   * delivers the offer before, or racing with, room:peer-joined), so an
   * unknown sender gets a link created on the spot.
   */
  private enqueue(peerId: string, task: (link: PeerLink) => Promise<void>): Promise<void> {
    if (this.closed || peerId === this.selfId) return Promise.resolve();
    const previous = this.queues.get(peerId) ?? Promise.resolve();
    const next = previous
      .then(() => {
        if (this.closed) return;
        // Resolved at run time, so a task sees the link a rebuild just made.
        return task(this.links.get(peerId) ?? this.createLink(peerId));
      })
      .catch((error: unknown) => console.warn('signaling task failed', peerId, error));
    this.queues.set(peerId, next);
    return next;
  }
}

function transceiverFor(pc: RTCPeerConnection, kind: MediaKind): RTCRtpTransceiver | undefined {
  return pc.getTransceivers().find((t) => t.receiver.track.kind === kind);
}
