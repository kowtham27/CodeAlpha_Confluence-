import type { MediaKind } from './transport';

export type MediaProblem = 'denied' | 'missing' | 'busy' | 'failed';

export interface AcquiredMedia {
  audio: MediaStreamTrack | null;
  video: MediaStreamTrack | null;
  problems: Partial<Record<MediaKind, MediaProblem>>;
}

/**
 * 640x360 is deliberate for a mesh: each participant uploads one copy per
 * peer, so five peers at 720p would need ~7 Mbps of upload. At 360p it is
 * ~2.5 Mbps, and tiles are rarely shown larger than that anyway.
 */
function constraints(kind: MediaKind, deviceId?: string): MediaTrackConstraints {
  const device = deviceId ? { deviceId: { exact: deviceId } } : {};
  return kind === 'audio'
    ? { ...device, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : {
        ...device,
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 24, max: 30 },
      };
}

function classify(error: unknown): MediaProblem {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'failed';
}

async function acquireOne(kind: MediaKind, deviceId?: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({ [kind]: constraints(kind, deviceId) });
  const track = stream.getTracks()[0];
  if (!track) throw new DOMException('No track returned', 'NotFoundError');
  return track;
}

/**
 * Asks for camera and microphone together (one permission prompt), and if
 * that fails, for each on its own: a broken camera must not also cost the
 * user their microphone.
 */
export async function acquireMedia(
  devices: Partial<Record<MediaKind, string>> = {},
): Promise<AcquiredMedia> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { audio: null, video: null, problems: { audio: 'failed', video: 'failed' } };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: constraints('audio', devices.audio),
      video: constraints('video', devices.video),
    });
    return {
      audio: stream.getAudioTracks()[0] ?? null,
      video: stream.getVideoTracks()[0] ?? null,
      problems: {},
    };
  } catch {
    const result: AcquiredMedia = { audio: null, video: null, problems: {} };
    for (const kind of ['audio', 'video'] as const) {
      try {
        result[kind] = await acquireOne(kind, devices[kind]);
      } catch (error) {
        result.problems[kind] = classify(error);
      }
    }
    return result;
  }
}

/** A replacement track from a specific device, for the device picker. */
export function acquireDevice(kind: MediaKind, deviceId: string): Promise<MediaStreamTrack> {
  return acquireOne(kind, deviceId);
}

export interface DeviceLists {
  audio: MediaDeviceInfo[];
  video: MediaDeviceInfo[];
}

/** Labels are only filled in once the user has granted permission. */
export async function listDevices(): Promise<DeviceLists> {
  if (!navigator.mediaDevices?.enumerateDevices) return { audio: [], video: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    audio: all.filter((d) => d.kind === 'audioinput'),
    video: all.filter((d) => d.kind === 'videoinput'),
  };
}

export const PROBLEM_TEXT: Record<MediaProblem, string> = {
  denied: 'blocked in your browser. Allow access in the site settings, then rejoin',
  missing: 'not found on this device',
  busy: 'in use by another app',
  failed: 'could not be started',
};

/** What the lobby hands to the call: which devices, and whether each starts on. */
export interface JoinPreferences {
  audio: boolean;
  video: boolean;
  devices: Partial<Record<MediaKind, string>>;
}

/** Straight into a call (a room you just created): everything on, default devices. */
export const DEFAULT_PREFERENCES: JoinPreferences = { audio: true, video: true, devices: {} };
