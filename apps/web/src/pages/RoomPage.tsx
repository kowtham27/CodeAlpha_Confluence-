import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type {
  AppError,
  IceServer,
  Participant,
  RoomSummary,
  ScreenSharer,
} from '@confluence/shared';
import { CallControls } from '../components/call/CallControls';
import { PresentationStage } from '../components/call/PresentationStage';
import { VideoTile } from '../components/call/VideoTile';
import { Alert, Button, FullPageSpinner, Logo } from '../components/ui';
import { canShareScreen, useCall } from '../hooks/useCall';
import { useRoom } from '../hooks/useRoom';
import { ApiError } from '../lib/api';
import { PROBLEM_TEXT } from '../lib/media/local-media';
import { endRoom, inviteLink, parseRoomInput, updateRoom } from '../lib/rooms';
import { useAuth } from '../stores/auth';

const REFUSAL_TITLES: Partial<Record<AppError['code'], string>> = {
  NOT_FOUND: 'Room not found',
  ROOM_LOCKED: 'This meeting is locked',
  ROOM_FULL: 'This meeting is full',
  RATE_LIMITED: 'Slow down',
};

/** Full-screen message for every way a join can end without a seat. */
function RoomMessage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <Logo />
      <div className="max-w-sm">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-3 text-sm text-ink-muted">{children}</div>
      </div>
    </main>
  );
}

function BackHome() {
  return (
    <Link to="/" className="mt-5 inline-block font-medium text-accent hover:underline">
      Back to your rooms
    </Link>
  );
}

function HostControls({ room }: { room: RoomSummary }) {
  const navigate = useNavigate();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [busy, setBusy] = useState<'lock' | 'end' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'lock' | 'end', action: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        busy={busy === 'lock'}
        aria-pressed={room.isLocked}
        onClick={() => void run('lock', () => updateRoom(room.slug, { isLocked: !room.isLocked }))}
      >
        {room.isLocked ? 'Unlock meeting' : 'Lock meeting'}
      </Button>
      {confirmEnd ? (
        <>
          <Button
            variant="danger"
            busy={busy === 'end'}
            onClick={() =>
              void run('end', async () => {
                await endRoom(room.slug);
                void navigate('/', { replace: true });
              })
            }
          >
            End for everyone
          </Button>
          <Button variant="ghost" onClick={() => setConfirmEnd(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="danger" onClick={() => setConfirmEnd(true)}>
          End meeting
        </Button>
      )}
      {error && <p className="w-full text-sm text-down">{error}</p>}
    </div>
  );
}

function CopyInvite({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Button
      variant="secondary"
      onClick={() =>
        void navigator.clipboard.writeText(inviteLink(slug)).then(() => setCopied(true))
      }
    >
      {copied ? 'Link copied' : 'Copy invite link'}
    </Button>
  );
}

export function RoomPage() {
  const { slug: rawSlug = '' } = useParams();
  const slug = parseRoomInput(rawSlug);
  if (!slug) {
    return (
      <RoomMessage title="Room not found">
        That link does not look right. Check it and try again.
        <br />
        <BackHome />
      </RoomMessage>
    );
  }
  return <Room slug={slug} />;
}

function Room({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const { state, participants, activity, rejoin } = useRoom(slug);
  const realtime = useAuth((s) => s.realtime);

  if (state.status === 'connecting' || state.status === 'joining') {
    return <FullPageSpinner label="Joining the meeting" />;
  }

  if (state.status === 'ended') {
    return (
      <RoomMessage title="This meeting has ended">
        The host ended the meeting for everyone.
        <br />
        <BackHome />
      </RoomMessage>
    );
  }

  if (state.status === 'displaced') {
    return (
      <RoomMessage title="You joined from somewhere else">
        This meeting is open in another tab or device. You can only be in it once.
        <div className="mt-5 flex justify-center">
          <Button onClick={() => void rejoin()}>Use this tab instead</Button>
        </div>
      </RoomMessage>
    );
  }

  if (state.status === 'refused') {
    return (
      <RoomMessage title={REFUSAL_TITLES[state.error.code] ?? 'Could not join'}>
        {state.error.message}
        <br />
        <BackHome />
      </RoomMessage>
    );
  }

  return (
    <InCall
      room={state.room}
      self={state.self}
      iceServers={state.iceServers}
      screen={state.screen}
      participants={participants}
      activity={activity?.text ?? null}
      realtimeOnline={realtime === 'online'}
      onLeave={() => void navigate('/')}
    />
  );
}

/** Spec: adaptive grid for 1, 2, 4 and 6 tiles. */
function gridClass(count: number): string {
  if (count <= 1) return 'mx-auto w-full max-w-3xl grid-cols-1';
  if (count === 2) return 'grid-cols-1 md:grid-cols-2';
  if (count <= 4) return 'grid-cols-1 sm:grid-cols-2';
  return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
}

interface InCallProps {
  room: RoomSummary;
  self: Participant;
  iceServers: IceServer[];
  screen: ScreenSharer | null;
  participants: Participant[];
  activity: string | null;
  realtimeOnline: boolean;
  onLeave: () => void;
}

function InCall({
  room,
  self,
  iceServers,
  screen,
  participants,
  activity,
  realtimeOnline,
  onLeave,
}: InCallProps) {
  const call = useCall({ slug: room.slug, self, iceServers, participants });
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  // Only trust a presenter who is actually in the participant list.
  const presenter = screen && participants.some((p) => p.peerId === screen.peerId) ? screen : null;

  async function toggleShare(): Promise<void> {
    setShareError(null);
    if (call.sharing) {
      await call.stopShare();
      return;
    }
    setShareError(await call.startShare());
  }
  const onPlaybackBlocked = useCallback(() => setSoundBlocked(true), []);
  const isHost = room.myRole === 'OWNER' || room.myRole === 'MODERATOR';

  // Our own tile reflects local state immediately, not the server round trip.
  const tiles = participants.map((p) =>
    p.userId === self.userId ? { ...p, media: call.enabled } : p,
  );

  const problems = (['audio', 'video'] as const)
    .filter((kind) => call.problems[kind])
    .map(
      (kind) =>
        `${kind === 'audio' ? 'Microphone' : 'Camera'} ${PROBLEM_TEXT[call.problems[kind] ?? 'failed']}.`,
    );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-edge bg-surface-raised">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-4">
            <Link to="/" aria-label="Back to your rooms">
              <Logo />
            </Link>
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 truncate text-base font-semibold">
                {room.name}
                {room.isLocked && (
                  <span className="rounded-md bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">
                    Locked
                  </span>
                )}
              </h1>
              <p className="text-xs text-ink-muted">
                {participants.length} of {room.maxParticipants} people · hosted by{' '}
                {room.owner.displayName}
              </p>
            </div>
          </div>
          <CopyInvite slug={room.slug} />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-6">
        {!realtimeOnline && (
          <Alert tone="warning">
            Connection lost. Reconnecting… you will rejoin automatically.
          </Alert>
        )}
        {room.isLocked && !isHost && (
          <Alert tone="warning">The host has locked this meeting. No one new can join.</Alert>
        )}
        {problems.length > 0 && (
          <Alert tone="warning">
            {problems.join(' ')} Others can still see and hear the rest of the meeting.
          </Alert>
        )}
        {shareError && <Alert tone="warning">{shareError}</Alert>}
        {soundBlocked && (
          <Alert tone="info">
            Your browser paused the meeting audio.{' '}
            <button
              type="button"
              className="font-medium text-accent hover:underline"
              onClick={() => {
                for (const v of document.querySelectorAll('video')) void v.play();
                setSoundBlocked(false);
              }}
            >
              Turn on sound
            </button>
          </Alert>
        )}

        {presenter && (
          <PresentationStage
            sharer={presenter}
            isSelf={presenter.userId === self.userId}
            stream={call.remoteStreams.get(presenter.peerId) ?? null}
            onStop={() => void toggleShare()}
          />
        )}

        {/* Spec: while someone presents, everyone moves to a filmstrip. */}
        <ul
          aria-label="Participants"
          className={
            presenter ? 'flex gap-3 overflow-x-auto pb-1' : `grid gap-4 ${gridClass(tiles.length)}`
          }
        >
          {tiles.map((p) => (
            <VideoTile
              key={p.userId}
              participant={p}
              isSelf={p.userId === self.userId}
              stream={
                p.userId === self.userId
                  ? call.localStream
                  : (call.remoteStreams.get(p.peerId) ?? null)
              }
              connection={call.peerStates.get(p.peerId)}
              speaking={call.speakingUserId === p.userId}
              onPlaybackBlocked={onPlaybackBlocked}
              compact={presenter !== null}
              hideVideo={presenter?.peerId === p.peerId}
            />
          ))}
        </ul>

        {participants.length === 1 && (
          <p className="text-center text-sm text-ink-muted">
            You are the only one here. Copy the invite link and send it to someone.
          </p>
        )}

        <div className="mt-auto flex flex-col gap-4 pt-2">
          {/* Sticky so Leave and Stop presenting are always reachable. */}
          <div className="sticky bottom-4 z-10">
            <CallControls
              enabled={call.enabled}
              available={call.available}
              devices={call.devices}
              selectedDevice={call.selectedDevice}
              onToggleAudio={call.toggleAudio}
              onToggleVideo={call.toggleVideo}
              onSwitchDevice={call.switchDevice}
              onLeave={onLeave}
              canShare={canShareScreen()}
              sharing={call.sharing}
              presenterName={presenter && !call.sharing ? presenter.displayName : null}
              onToggleShare={() => void toggleShare()}
            />
          </div>
          {isHost && (
            <section className="rounded-2xl border border-edge bg-surface-raised p-4">
              <h2 className="mb-3 text-sm font-semibold">Host controls</h2>
              <HostControls room={room} />
            </section>
          )}
        </div>

        {/* Spoken by screen readers; visually a small status line. */}
        <p aria-live="polite" className="min-h-5 text-center text-xs text-ink-muted">
          {activity}
        </p>
      </main>
    </div>
  );
}
