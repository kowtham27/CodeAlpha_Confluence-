import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Participant, RoomSummary } from '@confluence/shared';
import { ApiError } from '../../lib/api';
import { endRoom, inviteLink, updateRoom } from '../../lib/rooms';
import { Avatar, Button } from '../ui';
import { CheckIcon, CopyIcon, MicOffIcon } from './icons';
import { SidePanel } from './SidePanel';

/** Copies the room's invite link; says so for two seconds. */
export function CopyInvite({
  slug,
  tone = 'secondary',
}: {
  slug: string;
  tone?: 'secondary' | 'tonal';
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      variant={tone}
      onClick={() =>
        void navigator.clipboard.writeText(inviteLink(slug)).then(() => setCopied(true))
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Link copied' : 'Copy invite link'}
    </Button>
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
    <section
      aria-labelledby="host-controls"
      className="flex flex-col gap-4 border-t border-edge pt-5"
    >
      <h3 id="host-controls" className="text-[13px] font-medium text-ink-muted">
        Host controls
      </h3>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{room.isLocked ? 'Meeting locked' : 'Meeting open'}</p>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            {room.isLocked
              ? 'Only people already admitted can come back in.'
              : 'Anyone with the link can join.'}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          busy={busy === 'lock'}
          aria-pressed={room.isLocked}
          onClick={() =>
            void run('lock', () => updateRoom(room.slug, { isLocked: !room.isLocked }))
          }
        >
          {room.isLocked ? 'Unlock meeting' : 'Lock meeting'}
        </Button>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">End the meeting</p>
          <p className="mt-0.5 text-[13px] text-ink-muted">Removes everyone and closes the room.</p>
        </div>
        {confirmEnd ? (
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Button
              variant="danger"
              size="sm"
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
            <Button variant="ghost" size="sm" onClick={() => setConfirmEnd(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setConfirmEnd(true)}>
            End meeting
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-down">{error}</p>}
    </section>
  );
}

interface MeetingDetailsProps {
  room: RoomSummary;
  participants: Participant[];
  selfUserId: string;
  isHost: boolean;
  onClose: () => void;
}

export function MeetingDetails({
  room,
  participants,
  selfUserId,
  isHost,
  onClose,
}: MeetingDetailsProps) {
  const link = inviteLink(room.slug);
  return (
    <SidePanel title="Meeting details" closeLabel="Close meeting details" onClose={onClose}>
      <section aria-labelledby="joining-info" className="flex flex-col gap-3">
        <h3 id="joining-info" className="text-[13px] font-medium text-ink-muted">
          Joining info
        </h3>
        <p className="rounded-xl bg-surface-sunken px-4 py-3 text-[13px] break-all text-ink select-all">
          {link}
        </p>
        <div>
          <CopyInvite slug={room.slug} tone="tonal" />
        </div>
      </section>

      <section aria-labelledby="people" className="flex flex-col gap-1 border-t border-edge pt-5">
        <h3 id="people" className="mb-2 text-[13px] font-medium text-ink-muted">
          In the call · {participants.length} of {room.maxParticipants}
        </h3>
        <ul className="flex flex-col">
          {participants.map((p) => (
            <li key={p.userId} className="flex items-center gap-3 py-2">
              <Avatar name={p.displayName} seed={p.userId} className="size-9 text-sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {p.displayName}
                  {p.userId === selfUserId && <span className="text-ink-muted"> (you)</span>}
                </span>
                {p.role === 'OWNER' && (
                  <span className="block text-xs text-ink-muted">Meeting host</span>
                )}
              </span>
              {!p.media.audio && (
                <span role="img" aria-label="Microphone off" className="text-ink-muted">
                  <MicOffIcon size={18} />
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {isHost && <HostControls room={room} />}
    </SidePanel>
  );
}
