import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ackSchema,
  screenSharerSchema,
  type Ack,
  type IceServer,
  type Participant,
} from '@confluence/shared';
import { AudioMixer } from '../lib/media/audio-mix';
import {
  acquireDevice,
  acquireMedia,
  listDevices,
  type DeviceLists,
  type MediaProblem,
} from '../lib/media/local-media';
import { MeshTransport } from '../lib/media/mesh-transport';
import { signalingInbox } from '../lib/media/signaling-inbox';
import { SpeakingDetector } from '../lib/media/speaking';
import type { MediaKind } from '../lib/media/transport';
import { useSocket } from '../lib/realtime-context';

const SELF = 'self';
const claimAckSchema = ackSchema(screenSharerSchema);

interface ScreenShare {
  stream: MediaStream;
  mixer: AudioMixer | null;
}

/** The user closed the picker without choosing: not an error worth showing. */
function isCancelled(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'AbortError')
  );
}

export const canShareScreen = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

interface CallOptions {
  slug: string;
  self: Participant;
  iceServers: IceServer[];
  participants: Participant[];
  /** Each peer's direct-transfer data channel, as it is created. */
  onDataChannel?: (peerId: string, channel: RTCDataChannel) => void;
}

type Tracks = Record<MediaKind, MediaStreamTrack | null>;

/** Signaling acks only matter when something is wrong. */
function reportFailure(result: Ack<null>): void {
  if (!result.ok) console.warn('signaling refused:', result.error.code, result.error.message);
}

export function useCall({ slug, self, iceServers, participants, onDataChannel }: CallOptions) {
  const socket = useSocket();
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [enabled, setEnabled] = useState<Record<MediaKind, boolean>>({
    audio: false,
    video: false,
  });
  const [problems, setProblems] = useState<Partial<Record<MediaKind, MediaProblem>>>({});
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [peerStates, setPeerStates] = useState<Map<string, RTCPeerConnectionState>>(new Map());
  const [speakingPeer, setSpeakingPeer] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceLists>({ audio: [], video: [] });
  const [selectedDevice, setSelectedDevice] = useState<Partial<Record<MediaKind, string>>>({});

  const tracks = useRef<Tracks>({ audio: null, video: null });
  // Read at connection time, but not a reason to rebuild every connection:
  // each rejoin returns fresh TURN credentials in a new array.
  const iceServersRef = useRef(iceServers);
  iceServersRef.current = iceServers;
  const onDataChannelRef = useRef(onDataChannel);
  onDataChannelRef.current = onDataChannel;
  const transport = useRef<MeshTransport | null>(null);
  const detector = useRef<SpeakingDetector | null>(null);
  const share = useRef<ScreenShare | null>(null);
  const [sharing, setSharing] = useState(false);

  const refreshLocalStream = useCallback(() => {
    const live = [tracks.current.audio, tracks.current.video].filter(
      (t): t is MediaStreamTrack => t !== null,
    );
    const stream = live.length > 0 ? new MediaStream(live) : null;
    setLocalStream(stream);
    detector.current?.track(SELF, stream);
  }, []);

  // ---- speaking detection: one AudioContext for the call ---------------------
  useEffect(() => {
    const d = new SpeakingDetector(setSpeakingPeer);
    detector.current = d;
    // The context may start suspended until a user gesture.
    const wake = (): void => d.resume();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
      d.close();
      detector.current = null;
    };
  }, []);

  // ---- local camera and microphone, once per call --------------------------
  useEffect(() => {
    let cancelled = false;
    void acquireMedia().then(async (media) => {
      if (cancelled) {
        media.audio?.stop();
        media.video?.stop();
        return;
      }
      tracks.current = { audio: media.audio, video: media.video };
      setProblems(media.problems);
      setEnabled({ audio: media.audio !== null, video: media.video !== null });
      setSelectedDevice({
        ...(media.audio?.getSettings().deviceId
          ? { audio: media.audio.getSettings().deviceId }
          : {}),
        ...(media.video?.getSettings().deviceId
          ? { video: media.video.getSettings().deviceId }
          : {}),
      });
      refreshLocalStream();
      for (const track of [media.audio, media.video]) {
        if (track) await transport.current?.publish(track);
      }
      setDevices(await listDevices());
    });

    const onDeviceChange = (): void => {
      void listDevices().then(setDevices);
    };
    navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange);

    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange);
      tracks.current.audio?.stop();
      tracks.current.video?.stop();
      tracks.current = { audio: null, video: null };
    };
  }, [refreshLocalStream]);

  // ---- the transport: rebuilt whenever our peer id changes (reconnects) ----
  useEffect(() => {
    if (!socket) return;
    const mesh = new MeshTransport(
      self.peerId,
      iceServersRef.current,
      {
        sendDescription: (to, session, description) => {
          const payload = {
            to,
            session,
            description: {
              type: description.type as 'offer' | 'answer',
              sdp: description.sdp ?? '',
            },
          };
          if (description.type === 'offer') socket.emit('webrtc:offer', payload, reportFailure);
          else socket.emit('webrtc:answer', payload, reportFailure);
        },
        sendCandidate: (to, session, candidate) => {
          // Normalise the browser's all-optional RTCIceCandidateInit to the wire shape.
          const wire = candidate
            ? {
                candidate: candidate.candidate ?? '',
                sdpMid: candidate.sdpMid ?? null,
                sdpMLineIndex: candidate.sdpMLineIndex ?? null,
                usernameFragment: candidate.usernameFragment ?? null,
              }
            : null;
          socket.emit('webrtc:ice-candidate', { to, session, candidate: wire }, reportFailure);
        },
      },
      {
        onRemoteStream: (peerId, stream) => {
          setRemoteStreams((prev) => new Map(prev).set(peerId, stream));
          detector.current?.track(peerId, stream);
        },
        onPeerState: (peerId, state) => setPeerStates((prev) => new Map(prev).set(peerId, state)),
        onDataChannel: (peerId, channel) => onDataChannelRef.current?.(peerId, channel),
      },
    );
    transport.current = mesh;
    for (const track of [tracks.current.audio, tracks.current.video]) {
      if (track) void mesh.publish(track);
    }

    // Signaling that arrived before this transport existed is replayed first.
    const detach = signalingInbox(socket).attach((message) => {
      if (message.kind === 'description') {
        void mesh.handleDescription(message.from, message.session, message.description);
      } else {
        void mesh.handleCandidate(message.from, message.session, message.candidate);
      }
    });

    return () => {
      detach();
      mesh.close();
      transport.current = null;
      // A presentation belongs to these connections; the server frees the
      // slot when this socket leaves, so just stop capturing.
      if (share.current) {
        for (const t of share.current.stream.getTracks()) t.stop();
        share.current.mixer?.close();
        share.current = null;
        setSharing(false);
      }
      setRemoteStreams(new Map());
      setPeerStates(new Map());
    };
  }, [socket, self.peerId]);

  // ---- follow the participant list: one connection per other person ------
  useEffect(() => {
    const mesh = transport.current;
    if (!mesh) return;
    const present = new Set(participants.map((p) => p.peerId));
    for (const peerId of present) if (peerId !== self.peerId) mesh.subscribe(peerId);
    for (const peerId of mesh.peers().keys()) {
      if (present.has(peerId)) continue;
      mesh.unsubscribe(peerId);
      detector.current?.untrack(peerId);
      setRemoteStreams((prev) => {
        const next = new Map(prev);
        next.delete(peerId);
        return next;
      });
    }
  }, [participants, self.peerId]);

  // ---- tell the room our mic/camera state; again after every rejoin ------
  useEffect(() => {
    socket?.emit(
      'media:state',
      { slug, audio: enabled.audio, video: enabled.video },
      reportFailure,
    );
  }, [socket, slug, self.peerId, enabled.audio, enabled.video]);

  /** Spec: muting sets track.enabled = false; the track keeps running. */
  const toggle = useCallback((kind: MediaKind) => {
    const track = tracks.current[kind];
    if (!track) return;
    track.enabled = !track.enabled;
    setEnabled((prev) => ({ ...prev, [kind]: track.enabled }));
  }, []);

  const switchDevice = useCallback(
    async (kind: MediaKind, deviceId: string) => {
      const previous = tracks.current[kind];
      const next = await acquireDevice(kind, deviceId);
      // Carry the mute state across: switching mic must not unmute you.
      next.enabled = previous?.enabled ?? true;
      if (share.current && kind === 'video') {
        // The video sender is carrying the screen; the new camera takes over
        // when the presentation ends.
      } else if (share.current?.mixer && kind === 'audio') {
        share.current.mixer.setMic(next);
      } else {
        await transport.current?.publish(next);
      }
      previous?.stop();
      tracks.current = { ...tracks.current, [kind]: next };
      setSelectedDevice((prev) => ({ ...prev, [kind]: deviceId }));
      setProblems((prev) => {
        const rest = { ...prev };
        delete rest[kind];
        return rest;
      });
      if (!previous) setEnabled((prev) => ({ ...prev, [kind]: true }));
      refreshLocalStream();
    },
    [refreshLocalStream],
  );

  /** Ends a presentation and puts the camera and microphone back. */
  const stopShare = useCallback(async () => {
    const current = share.current;
    if (!current) return;
    share.current = null;
    for (const t of current.stream.getTracks()) t.stop();
    current.mixer?.close();
    const mesh = transport.current;
    if (mesh) {
      const { audio, video } = tracks.current;
      await (video ? mesh.publish(video) : mesh.unpublish('video'));
      await (audio ? mesh.publish(audio) : mesh.unpublish('audio'));
    }
    setSharing(false);
    socket?.emit('screen:release', { slug }, reportFailure);
  }, [socket, slug]);

  /**
   * Claims the room's screen slot, then asks the browser for a screen.
   * Claiming first means a busy room fails fast, before the picker opens.
   * Returns a message to show, or null for success and for a cancelled picker.
   */
  const startShare = useCallback(async (): Promise<string | null> => {
    if (!socket || share.current) return null;
    const claim = claimAckSchema.parse(
      (await socket.timeout(10_000).emitWithAck('screen:claim', { slug })) as unknown,
    );
    if (!claim.ok) return claim.error.message;

    let stream: MediaStream;
    try {
      // Spec: 15 fps is plenty for slides and code, and halves the bitrate.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: true,
      });
    } catch (error) {
      socket.emit('screen:release', { slug }, reportFailure);
      return isCancelled(error) ? null : 'Screen sharing could not start.';
    }

    const video = stream.getVideoTracks()[0];
    if (!video) {
      for (const t of stream.getTracks()) t.stop();
      socket.emit('screen:release', { slug }, reportFailure);
      return 'No screen was shared.';
    }
    // Tells the encoder to keep text sharp (resolution) over motion (frame rate).
    video.contentHint = 'detail';
    const screenAudio = stream.getAudioTracks()[0] ?? null;
    const mixer = screenAudio ? new AudioMixer(tracks.current.audio, screenAudio) : null;
    share.current = { stream, mixer };

    // The browser's own "Stop sharing" button ends the track: restore the camera.
    video.addEventListener('ended', () => void stopShare());

    // Spec: replaceTrack on every connection, no renegotiation.
    await transport.current?.publish(video);
    if (mixer?.track) await transport.current?.publish(mixer.track);
    setSharing(true);
    return null;
  }, [socket, slug, stopShare]);

  const speakingUserId =
    speakingPeer === SELF
      ? self.userId
      : (participants.find((p) => p.peerId === speakingPeer)?.userId ?? null);

  return {
    localStream,
    enabled,
    available: { audio: tracks.current.audio !== null, video: tracks.current.video !== null },
    problems,
    remoteStreams,
    peerStates,
    speakingUserId,
    devices,
    selectedDevice,
    sharing,
    startShare,
    stopShare,
    toggleAudio: () => toggle('audio'),
    toggleVideo: () => toggle('video'),
    switchDevice,
  };
}
