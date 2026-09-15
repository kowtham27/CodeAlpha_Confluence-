import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { RoomSummary } from '@confluence/shared';
import { ApiError } from '../../lib/api';
import {
  acquireDevice,
  acquireMedia,
  listDevices,
  PROBLEM_TEXT,
  type DeviceLists,
  type JoinPreferences,
  type MediaProblem,
} from '../../lib/media/local-media';
import type { MediaKind } from '../../lib/media/transport';
import { getRoom } from '../../lib/rooms';
import { useAuth } from '../../stores/auth';
import { ThemeSwitcher } from '../ThemeSwitcher';
import { Alert, Button, FullPageSpinner, Logo } from '../ui';
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from './icons';

type LobbyState =
  | { status: 'loading' }
  | { status: 'ready'; room: RoomSummary }
  | { status: 'unavailable'; title: string; message: string };

interface LobbyProps {
  slug: string;
  onJoin: (preferences: JoinPreferences) => void;
  /** How the room page shows a room that cannot be joined. */
  renderMessage: (title: string, message: string) => ReactNode;
}

/**
 * The pre-join screen (spec Phase 8): check your camera and microphone,
 * choose devices, decide what starts on, then join. Nothing is shared and
 * no seat is taken until "Join now". The room is checked first, so a bad,
 * ended or locked link explains itself before any device is touched.
 */
export function Lobby({ slug, onJoin, renderMessage }: LobbyProps) {
  const user = useAuth((s) => s.user);
  const [state, setState] = useState<LobbyState>({ status: 'loading' });
  const [tracks, setTracks] = useState<Record<MediaKind, MediaStreamTrack | null>>({
    audio: null,
    video: null,
  });
  const [problems, setProblems] = useState<Partial<Record<MediaKind, MediaProblem>>>({});
  const [on, setOn] = useState<Record<MediaKind, boolean>>({ audio: true, video: true });
  const [devices, setDevices] = useState<DeviceLists>({ audio: [], video: [] });
  const video = useRef<HTMLVideoElement>(null);
  const live = useRef(tracks);
  live.current = tracks;

  useEffect(() => {
    let cancelled = false;
    getRoom(slug)
      .then((room) => {
        if (cancelled) return;
        if (room.endedAt) {
          setState({
            status: 'unavailable',
            title: 'This meeting has ended',
            message: 'The host ended the meeting for everyone.',
          });
        } else if (room.isLocked && room.myRole === null) {
          setState({
            status: 'unavailable',
            title: 'This meeting is locked',
            message: 'The host has locked this meeting. Ask them to unlock it, then try again.',
          });
        } else {
          setState({ status: 'ready', room });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const missing = error instanceof ApiError && error.code === 'NOT_FOUND';
        setState({
          status: 'unavailable',
          title: missing ? 'Room not found' : 'Could not open this room',
          message: missing
            ? 'This room does not exist. Check the link.'
            : 'The server did not answer. Try again in a moment.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Preview only once the room is known to be joinable.
  const ready = state.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void acquireMedia().then(async (media) => {
      if (cancelled) {
        media.audio?.stop();
        media.video?.stop();
        return;
      }
      setTracks({ audio: media.audio, video: media.video });
      setProblems(media.problems);
      setOn({ audio: media.audio !== null, video: media.video !== null });
      setDevices(await listDevices());
    });
    return () => {
      cancelled = true;
      // The call acquires its own tracks; the preview never outlives the lobby.
      live.current.audio?.stop();
      live.current.video?.stop();
    };
  }, [ready]);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = tracks.video ? new MediaStream([tracks.video]) : null;
  }, [tracks.video, ready]);

  async function switchDevice(kind: MediaKind, deviceId: string) {
    try {
      const next = await acquireDevice(kind, deviceId);
      live.current[kind]?.stop();
      setTracks((prev) => ({ ...prev, [kind]: next }));
      setProblems((prev) => ({ ...prev, [kind]: undefined }));
      setOn((prev) => ({ ...prev, [kind]: true }));
    } catch {
      setProblems((prev) => ({ ...prev, [kind]: 'failed' }));
    }
  }

  function join() {
    onJoin({
      audio: on.audio && tracks.audio !== null,
      video: on.video && tracks.video !== null,
      devices: {
        ...(tracks.audio?.getSettings().deviceId && { audio: tracks.audio.getSettings().deviceId }),
        ...(tracks.video?.getSettings().deviceId && { video: tracks.video.getSettings().deviceId }),
      },
    });
  }

  if (state.status === 'loading') return <FullPageSpinner label="Opening the meeting" />;
  if (state.status === 'unavailable') return renderMessage(state.title, state.message);

  const { room } = state;
  const others = room.participantCount;
  const issues = (['audio', 'video'] as const)
    .filter((kind) => problems[kind])
    .map(
      (kind) =>
        `${kind === 'audio' ? 'Microphone' : 'Camera'} ${PROBLEM_TEXT[problems[kind] ?? 'failed']}.`,
    );

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <Logo />
        <div className="flex items-center gap-4">
          {user && (
            <span className="hidden text-right text-[13px] leading-4 sm:block">
              <span className="block text-ink">{user.displayName}</span>
              <span className="block text-ink-muted">{user.email}</span>
            </span>
          )}
          <ThemeSwitcher />
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 content-center items-center gap-10 px-5 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:gap-16">
        <div className="flex flex-col gap-4">
          <div className="relative aspect-video overflow-hidden rounded-2xl bg-stage shadow-[0_12px_40px_-12px_rgba(15,23,42,0.35)]">
            <video
              ref={video}
              autoPlay
              playsInline
              muted
              aria-label="Your camera preview"
              className={`absolute inset-0 size-full -scale-x-100 object-cover transition-opacity duration-300 ${
                on.video && tracks.video ? 'opacity-100' : 'opacity-0'
              }`}
            />
            {!(on.video && tracks.video) && (
              <p className="absolute inset-0 flex items-center justify-center text-lg text-stage-ink">
                {tracks.video ? 'Camera is off' : 'No camera found'}
              </p>
            )}
            {user && (
              <span className="absolute top-4 left-5 text-sm font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]">
                {user.displayName}
              </span>
            )}
            <div className="absolute inset-x-0 bottom-0 flex justify-center gap-4 bg-gradient-to-t from-black/50 to-transparent pt-12 pb-5">
              <PreviewToggle
                label={on.audio ? 'Join with microphone off' : 'Join with microphone on'}
                pressed={!on.audio}
                disabled={!tracks.audio}
                onClick={() => setOn((prev) => ({ ...prev, audio: !prev.audio }))}
              >
                {on.audio ? <MicIcon /> : <MicOffIcon />}
              </PreviewToggle>
              <PreviewToggle
                label={on.video ? 'Join with camera off' : 'Join with camera on'}
                pressed={!on.video}
                disabled={!tracks.video}
                onClick={() => setOn((prev) => ({ ...prev, video: !prev.video }))}
              >
                {on.video ? <CameraIcon /> : <CameraOffIcon />}
              </PreviewToggle>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <DevicePicker
              label="Microphone"
              options={devices.audio}
              value={tracks.audio?.getSettings().deviceId}
              onChange={(id) => void switchDevice('audio', id)}
            />
            <DevicePicker
              label="Camera"
              options={devices.video}
              value={tracks.video?.getSettings().deviceId}
              onChange={(id) => void switchDevice('video', id)}
            />
          </div>
        </div>

        <div className="flex flex-col items-center gap-6 text-center lg:items-start lg:text-left">
          <div>
            <p className="text-[15px] text-ink-muted">Ready to join?</p>
            <h1 className="mt-1 text-[36px] leading-[44px] font-normal tracking-[-0.02em]">
              {room.name}
            </h1>
            <p className="mt-3 text-[15px] text-ink-muted">
              Hosted by {room.owner.displayName} ·{' '}
              {others === 0
                ? 'No one is here yet'
                : `${others} ${others === 1 ? 'person is' : 'people are'} here`}
            </p>
          </div>
          {issues.length > 0 && <Alert tone="warning">{issues.join(' ')}</Alert>}
          <Button onClick={join} className="h-12 px-10 text-[15px]">
            Join now
          </Button>
          <p className="text-[13px] text-ink-muted">
            Joining as <span className="font-medium text-ink">{user?.displayName}</span>. Chat,
            files and the whiteboard are end-to-end encrypted.
          </p>
        </div>
      </main>
    </div>
  );
}

function PreviewToggle({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  /** Off: styled as a warning. The label already says what a click does. */
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-14 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
        pressed
          ? 'bg-stage-danger text-white hover:bg-stage-danger-hover'
          : 'border border-white/70 text-white hover:bg-white/15'
      }`}
    >
      {children}
    </button>
  );
}

function DevicePicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: MediaDeviceInfo[];
  value: string | undefined;
  onChange: (deviceId: string) => void;
}) {
  const id = useId();
  if (options.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-full border border-edge-strong/40 bg-surface-raised py-1 pr-2 pl-4">
      <label htmlFor={id} className="shrink-0 text-[13px] text-ink-muted">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 min-w-0 flex-1 cursor-pointer truncate rounded-full bg-transparent px-2 text-[13px] text-ink hover:bg-ink/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {options.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </div>
  );
}
