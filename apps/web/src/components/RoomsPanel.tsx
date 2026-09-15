import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { RoomSummary } from '@confluence/shared';
import { ApiError } from '../lib/api';
import { createRoom, listRooms, parseRoomInput } from '../lib/rooms';
import { Alert, Button, Spinner } from './ui';

const icon = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const VideoPlusIcon = () => (
  <svg {...icon}>
    <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
    <path d="M15.5 10.5 21 7.5v9l-5.5-3M9 9.5v5M6.5 12h5" />
  </svg>
);

const KeyboardIcon = () => (
  <svg {...icon}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9" />
  </svg>
);

/**
 * Start a meeting, or join one. Two compact rows, the way people expect a
 * meeting app to open: a name and a button, or a link and a button.
 */
export function StartOrJoin() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const room = await createRoom(name);
      // Straight into the call: they just chose to start it (no lobby).
      void navigate(`/r/${room.slug}`, { state: { created: true } });
    } catch (caught) {
      setCreateError(
        caught instanceof ApiError
          ? (caught.details?.['name']?.[0] ?? caught.message)
          : 'Could not create the room.',
      );
      setCreating(false);
    }
  }

  function onJoin(event: FormEvent) {
    event.preventDefault();
    const slug = parseRoomInput(code);
    if (!slug) {
      setCodeError('Paste an invite link or a room code.');
      return;
    }
    void navigate(`/r/${slug}`);
  }

  const field =
    'h-12 w-full rounded-full border bg-surface-raised pr-4 pl-11 text-[15px] text-ink placeholder:text-ink-muted/80 transition-[border-color,box-shadow] focus:outline-none focus-visible:outline-none';

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => void onCreate(e)}
        noValidate
        className="flex flex-col gap-3 sm:flex-row sm:items-start"
      >
        <div className="relative flex-1">
          <label htmlFor="new-meeting" className="sr-only">
            Start a new meeting
          </label>
          <span className="pointer-events-none absolute top-3.5 left-4 text-ink-muted">
            <VideoPlusIcon />
          </span>
          <input
            id="new-meeting"
            placeholder="Name your meeting"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={createError ? true : undefined}
            aria-describedby={createError ? 'new-meeting-error' : undefined}
            className={`${field} ${createError ? 'border-down focus:ring-1 focus:ring-down' : 'border-edge-strong/50 hover:border-edge-strong focus:border-accent focus:ring-1 focus:ring-accent'}`}
          />
          {createError && (
            <p id="new-meeting-error" className="mt-1.5 pl-4 text-xs text-down">
              {createError}
            </p>
          )}
        </div>
        <Button type="submit" busy={creating} className="h-12 px-7">
          Start meeting
        </Button>
      </form>

      <div className="flex items-center gap-3 text-xs text-ink-muted">
        <span className="h-px flex-1 bg-edge" />
        or join one
        <span className="h-px flex-1 bg-edge" />
      </div>

      <form onSubmit={onJoin} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="relative flex-1">
          <label htmlFor="join-code" className="sr-only">
            Join with a link or code
          </label>
          <span className="pointer-events-none absolute top-3.5 left-4 text-ink-muted">
            <KeyboardIcon />
          </span>
          <input
            id="join-code"
            placeholder="Enter a link or code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setCodeError(null);
            }}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={codeError ? 'join-code-error' : undefined}
            className={`${field} ${codeError ? 'border-down focus:ring-1 focus:ring-down' : 'border-edge-strong/50 hover:border-edge-strong focus:border-accent focus:ring-1 focus:ring-accent'}`}
          />
          {codeError && (
            <p id="join-code-error" className="mt-1.5 pl-4 text-xs text-down">
              {codeError}
            </p>
          )}
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={code.trim() === ''}
          className="h-12 px-7"
        >
          Join
        </Button>
      </form>
    </div>
  );
}

function RoomRow({ room }: { room: RoomSummary }) {
  const ended = room.endedAt !== null;
  const live = !ended && room.participantCount > 0;
  const date = new Date(room.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return (
    <li>
      <Link
        to={`/r/${room.slug}`}
        aria-disabled={ended}
        className={`group flex items-center gap-4 rounded-2xl px-3 py-3 transition-colors ${
          ended ? 'pointer-events-none' : 'hover:bg-ink/5'
        }`}
      >
        <span
          aria-hidden="true"
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
            ended ? 'bg-surface-sunken text-ink-muted' : 'bg-accent-soft text-accent-soft-ink'
          }`}
        >
          <VideoPlusIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`flex items-center gap-2 truncate text-[15px] font-medium ${ended ? 'text-ink-muted' : ''}`}
          >
            <span className="truncate">{room.name}</span>
            {room.isLocked && !ended && (
              <span className="rounded-full bg-warn-soft px-2 py-px text-[11px] font-medium text-warn">
                Locked
              </span>
            )}
          </span>
          <span className="block truncate text-[13px] text-ink-muted">
            {ended
              ? `Ended · ${date}`
              : `${room.myRole === 'OWNER' ? 'You host' : `Hosted by ${room.owner.displayName}`} · ${date}`}
          </span>
        </span>
        {live ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-up-soft px-2.5 py-1 text-xs font-medium text-up">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-up" />
            {room.participantCount} in now
          </span>
        ) : (
          !ended && (
            <span className="shrink-0 text-[13px] font-medium text-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              Open
            </span>
          )
        )}
      </Link>
    </li>
  );
}

/** Rooms you created or joined, newest and live ones first. */
export function RoomsList() {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    listRooms()
      .then(setRooms)
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : 'Could not load your rooms.'),
      );
  }, []);

  return (
    <section aria-labelledby="rooms-title">
      <h2 id="rooms-title" className="mb-2 px-3 text-[13px] font-medium text-ink-muted">
        Your meetings
      </h2>
      {loadError && <Alert tone="error">{loadError}</Alert>}
      {!loadError && rooms === null && (
        <p className="px-3 text-ink-muted">
          <Spinner label="Loading your meetings" />
        </p>
      )}
      {rooms?.length === 0 && (
        <p className="px-3 text-sm text-ink-muted">
          No rooms yet. Start one above, then share its link.
        </p>
      )}
      {rooms && rooms.length > 0 && (
        <ul aria-label="Your rooms" className="-mx-0 flex flex-col">
          {rooms.map((room) => (
            <RoomRow key={room.slug} room={room} />
          ))}
        </ul>
      )}
    </section>
  );
}
