import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { RoomSummary } from '@confluence/shared';
import { ApiError } from '../lib/api';
import { createRoom, listRooms, parseRoomInput } from '../lib/rooms';
import { Alert, Button, Field } from './ui';

function RoomRow({ room }: { room: RoomSummary }) {
  const ended = room.endedAt !== null;
  return (
    <li>
      <Link
        to={`/r/${room.slug}`}
        aria-disabled={ended}
        className={`flex items-center justify-between gap-4 rounded-xl border border-edge px-4 py-3 ${
          ended
            ? 'pointer-events-none opacity-60'
            : 'hover:border-edge-strong hover:bg-surface-sunken'
        }`}
      >
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate text-sm font-medium">
            {room.name}
            {room.myRole === 'OWNER' && (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                Host
              </span>
            )}
            {room.isLocked && !ended && (
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">
                Locked
              </span>
            )}
          </p>
          <p className="text-xs text-ink-muted">
            {ended
              ? 'Ended'
              : `Hosted by ${room.owner.displayName} · ${new Date(room.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`}
          </p>
        </div>
        {!ended && (
          <span className="flex shrink-0 items-center gap-2 text-xs text-ink-muted">
            {room.participantCount > 0 && (
              <span aria-hidden="true" className="inline-block size-2 rounded-full bg-up" />
            )}
            {room.participantCount > 0 ? `${room.participantCount} in now` : 'Empty'}
          </span>
        )}
      </Link>
    </li>
  );
}

export function RoomsPanel() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  useEffect(() => {
    listRooms()
      .then(setRooms)
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : 'Could not load your rooms.'),
      );
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const room = await createRoom(name);
      void navigate(`/r/${room.slug}`);
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

  return (
    <section className="rounded-2xl border border-edge bg-surface-raised p-5">
      <h2 className="text-sm font-semibold">Your rooms</h2>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <form onSubmit={(e) => void onCreate(e)} className="flex flex-col gap-3" noValidate>
          <Field
            label="Start a new meeting"
            placeholder="Meeting name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            errors={createError ? [createError] : undefined}
          />
          <Button type="submit" busy={creating} className="self-start">
            Create room
          </Button>
        </form>
        <form onSubmit={onJoin} className="flex flex-col gap-3" noValidate>
          <Field
            label="Join with a link or code"
            placeholder="Paste an invite link"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setCodeError(null);
            }}
            errors={codeError ? [codeError] : undefined}
          />
          <Button type="submit" variant="secondary" className="self-start">
            Join
          </Button>
        </form>
      </div>

      <div className="mt-6 border-t border-edge pt-4">
        {loadError && <Alert tone="error">{loadError}</Alert>}
        {!loadError && rooms === null && <p className="text-sm text-ink-muted">Loading…</p>}
        {rooms?.length === 0 && (
          <p className="text-sm text-ink-muted">
            No rooms yet. Create one above, then share its link.
          </p>
        )}
        {rooms && rooms.length > 0 && (
          <ul aria-label="Your rooms" className="flex flex-col gap-2">
            {rooms.map((room) => (
              <RoomRow key={room.slug} room={room} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
