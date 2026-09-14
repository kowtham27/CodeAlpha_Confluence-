import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AppError, Participant, RoomSummary } from '@confluence/shared';
import { Alert, Button, FullPageSpinner, Logo } from '../components/ui';
import { useRoom } from '../hooks/useRoom';
import { ApiError } from '../lib/api';
import { endRoom, inviteLink, parseRoomInput, updateRoom } from '../lib/rooms';
import { useAuth } from '../stores/auth';

const REFUSAL_TITLES: Partial<Record<AppError['code'], string>> = {
  NOT_FOUND: 'Room not found',
  ROOM_LOCKED: 'This meeting is locked',
  ROOM_FULL: 'This meeting is full',
  RATE_LIMITED: 'Slow down',
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

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

function ParticipantTile({ participant, isSelf }: { participant: Participant; isSelf: boolean }) {
  return (
    <li className="relative flex aspect-video flex-col items-center justify-center gap-3 rounded-2xl border border-edge bg-surface-sunken">
      <span
        aria-hidden="true"
        className="flex size-16 items-center justify-center rounded-full bg-accent-soft text-xl font-semibold text-accent"
      >
        {initials(participant.displayName)}
      </span>
      <span className="absolute bottom-3 left-3 flex items-center gap-2 rounded-md bg-surface-raised/90 px-2 py-1 text-xs font-medium">
        {participant.displayName}
        {isSelf && <span className="text-ink-muted">(you)</span>}
        {participant.role === 'OWNER' && (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
            Host
          </span>
        )}
      </span>
    </li>
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

  const { room, self } = state;
  const isHost = room.myRole === 'OWNER' || room.myRole === 'MODERATOR';

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
          <div className="flex flex-wrap items-center gap-2">
            <CopyInvite slug={room.slug} />
            <Button variant="ghost" onClick={() => void navigate('/')}>
              Leave
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6">
        {realtime !== 'online' && (
          <Alert tone="warning">
            Connection lost. Reconnecting… you will rejoin automatically.
          </Alert>
        )}
        {room.isLocked && !isHost && (
          <Alert tone="warning">The host has locked this meeting. No one new can join.</Alert>
        )}

        <ul aria-label="Participants" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {participants.map((p) => (
            <ParticipantTile key={p.userId} participant={p} isSelf={p.userId === self.userId} />
          ))}
        </ul>

        {participants.length === 1 && (
          <p className="text-center text-sm text-ink-muted">
            You are the only one here. Copy the invite link and send it to someone.
          </p>
        )}

        {isHost && (
          <section className="mt-auto rounded-2xl border border-edge bg-surface-raised p-4">
            <h2 className="mb-3 text-sm font-semibold">Host controls</h2>
            <HostControls room={room} />
          </section>
        )}

        {/* Spoken by screen readers; visually a small status line. */}
        <p aria-live="polite" className="min-h-5 text-center text-xs text-ink-muted">
          {activity?.text}
        </p>
      </main>
    </div>
  );
}
