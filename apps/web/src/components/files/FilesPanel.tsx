import { useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import type { Participant } from '@confluence/shared';
import type { RoomKeyState } from '../../hooks/useRoomKey';
import type { RoomFile, useRoomFiles } from '../../hooks/useRoomFiles';
import type { DirectTransfer, DirectTransfers } from '../../lib/files/direct';
import { formatBytes, saveBlob } from '../../lib/files/save';
import { sniffFile } from '../../lib/files/sniff';
import { KeyStatus } from '../keys/KeyStatus';
import { SidePanel } from '../call/SidePanel';
import { Alert, Button, IconButton, ProgressBar, Spinner } from '../ui';
import { CloseIcon, DownloadIcon, FileIcon, TrashIcon } from '../call/icons';

type Mode = 'keep' | 'direct';

interface FilesPanelProps {
  selfUserId: string;
  isHost: boolean;
  participants: Participant[];
  roomKey: RoomKeyState;
  files: ReturnType<typeof useRoomFiles>;
  direct: DirectTransfers;
  onClose: () => void;
}

const ACCEPT =
  '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json,.log,.zip,.docx,.xlsx,.pptx,.odt,.ods,.odp,.mp4,.m4v,.mov,.webm,.mp3,.m4a,.wav';

const UploadIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
  </svg>
);

function daysLeft(expiresAt: string): string {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  return days <= 1 ? 'expires today' : `expires in ${days} days`;
}

export function FilesPanel({
  selfUserId,
  isHost,
  participants,
  roomKey,
  files,
  direct,
  onClose,
}: FilesPanelProps) {
  const { transfers, openPeers } = useSyncExternalStore(direct.subscribe, direct.getSnapshot);
  const [mode, setMode] = useState<Mode>('keep');
  const [dragging, setDragging] = useState(false);
  const [refusals, setRefusals] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const nameOf = (peerId: string) =>
    participants.find((p) => p.peerId === peerId)?.displayName ?? 'Someone who left';
  const canKeep = roomKey.status === 'ready';
  const canDirect = openPeers.length > 0;
  const canSend = mode === 'keep' ? canKeep : canDirect;

  async function accept(list: FileList | File[]) {
    const problems: string[] = [];
    for (const file of Array.from(list)) {
      const verdict = await sniffFile(file, file.name);
      if (!verdict.ok) {
        problems.push(`${file.name}: ${verdict.reason}`);
        continue;
      }
      if (mode === 'keep') void files.upload(file, verdict.type);
      else direct.send(openPeers, file, verdict.type);
    }
    setRefusals(problems);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (canSend && e.dataTransfer.files.length > 0) void accept(e.dataTransfer.files);
  }

  return (
    <SidePanel title="Files" closeLabel="Close files" onClose={onClose}>
      <KeyStatus
        state={roomKey}
        userId={selfUserId}
        readyText="End-to-end encrypted. The server cannot read these files or their names."
        waitingText="Waiting for someone who already has this room’s key. It is shared automatically when you are both in the call. You can still send files directly."
      />

      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="sr-only">How to share</legend>
        <ModeOption
          checked={mode === 'keep'}
          onSelect={() => setMode('keep')}
          title="Keep in this room"
          detail="Everyone in the room, now and later. Deleted after 7 days."
        />
        <ModeOption
          checked={mode === 'direct'}
          onSelect={() => setMode('direct')}
          title="Send directly"
          detail={
            canDirect
              ? 'Only people in the call right now. Never stored.'
              : 'No one else is connected yet.'
          }
        />
      </fieldset>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-3 rounded-2xl border border-dashed px-4 py-7 text-center text-sm transition-colors ${
          dragging && canSend
            ? 'border-accent bg-accent-soft'
            : 'border-edge-strong/50 bg-surface-sunken/60'
        }`}
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-surface-raised text-accent shadow-sm">
          <UploadIcon />
        </span>
        <p className="text-ink-muted">Drag files here, or</p>
        <Button
          variant="tonal"
          size="sm"
          disabled={!canSend}
          onClick={() => inputRef.current?.click()}
        >
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose files to share"
          data-testid="file-input"
          onChange={(e) => {
            if (e.target.files) void accept(e.target.files);
            e.target.value = '';
          }}
        />
        <p className="text-xs text-ink-muted">
          Up to 100 MB. Images, PDFs, Office documents, text, audio and video.
        </p>
      </div>

      {refusals.length > 0 && (
        <Alert tone="warning">
          {refusals.map((r) => (
            <span key={r} className="block">
              {r}
            </span>
          ))}
        </Alert>
      )}
      {files.error && <Alert tone="error">{files.error}</Alert>}

      {files.uploads.length > 0 && (
        <ul aria-label="Uploads in progress" className="flex flex-col gap-3">
          {files.uploads.map((u) => (
            <li key={u.key} className="flex flex-col gap-1.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{u.name}</span>
                {u.phase === 'failed' ? (
                  <button
                    type="button"
                    className="text-xs text-ink-muted hover:text-ink"
                    onClick={() => files.dismissUpload(u.key)}
                  >
                    Dismiss
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-xs text-ink-muted hover:text-ink"
                    onClick={() => files.cancelUpload(u.key)}
                  >
                    Cancel
                  </button>
                )}
              </div>
              {u.phase === 'failed' ? (
                <p className="text-xs text-down">{u.error}</p>
              ) : (
                <>
                  <ProgressBar value={u.progress} label={`${u.name}: ${u.phase}`} />
                  <p className="text-xs text-ink-muted">
                    {u.phase === 'encrypting' && 'Encrypting…'}
                    {u.phase === 'uploading' && `Uploading ${Math.round(u.progress * 100)}%`}
                    {u.phase === 'finishing' && 'Finishing…'}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div>
        <h3 className="mb-1 text-[13px] font-medium text-ink-muted">Shared in this room</h3>
        {!canKeep ? (
          <p className="text-sm text-ink-muted">Available once encryption is ready.</p>
        ) : !files.loaded ? (
          <Spinner label="Loading files" />
        ) : files.files.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing shared yet.</p>
        ) : (
          <ul aria-label="Shared files" className="flex flex-col divide-y divide-edge">
            {files.files.map((f) => (
              <SharedFileRow
                key={f.summary.id}
                file={f}
                download={files.downloads.get(f.summary.id)}
                canDelete={isHost || f.summary.uploader.userId === selfUserId}
                onDownload={() => void files.download(f)}
                onDelete={() => void files.remove(f)}
              />
            ))}
          </ul>
        )}
      </div>

      {transfers.length > 0 && (
        <div>
          <h3 className="mb-2 text-[13px] font-medium text-ink-muted">Sent directly</h3>
          <ul aria-label="Direct transfers" className="flex flex-col gap-3">
            {transfers.map((t) => (
              <DirectRow key={t.key} transfer={t} peerName={nameOf(t.peerId)} direct={direct} />
            ))}
          </ul>
        </div>
      )}
    </SidePanel>
  );
}

function ModeOption({
  checked,
  onSelect,
  title,
  detail,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-2xl border px-4 py-3 transition-colors ${
        checked ? 'border-accent bg-accent-soft/60' : 'border-edge hover:bg-ink/4'
      }`}
    >
      <input
        type="radio"
        name="share-mode"
        checked={checked}
        onChange={onSelect}
        className="mt-1 accent-accent"
      />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-ink-muted">{detail}</span>
      </span>
    </label>
  );
}

function SharedFileRow({
  file,
  download,
  canDelete,
  onDownload,
  onDelete,
}: {
  file: RoomFile;
  download: { phase: string; progress: number } | undefined;
  canDelete: boolean;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { summary, meta } = file;
  const name = meta?.name ?? 'Unreadable file';

  return (
    <li className="flex flex-col gap-2 py-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-soft-ink">
          <FileIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={name}>
            {name}
          </p>
          <p className="text-xs text-ink-muted">
            {meta ? formatBytes(meta.size) : 'Shared under an older room key'} ·{' '}
            {summary.uploader.displayName} · {daysLeft(summary.expiresAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {meta && (
            <IconButton
              label={`Download ${name}`}
              onClick={onDownload}
              disabled={download !== undefined}
              className="size-9"
            >
              <DownloadIcon />
            </IconButton>
          )}
          {canDelete && !confirming && (
            <IconButton
              label={`Delete ${name}`}
              onClick={() => setConfirming(true)}
              className="size-9 hover:bg-down-soft hover:text-down"
            >
              <TrashIcon />
            </IconButton>
          )}
        </div>
      </div>
      {confirming && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-ink-muted">Delete for everyone?</span>
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      )}
      {download && (
        <>
          <ProgressBar value={download.progress} label={`${name}: ${download.phase}`} />
          <p className="text-xs text-ink-muted">
            {download.phase === 'downloading'
              ? `Downloading ${Math.round(download.progress * 100)}%`
              : 'Decrypting…'}
          </p>
        </>
      )}
    </li>
  );
}

function DirectRow({
  transfer: t,
  peerName,
  direct,
}: {
  transfer: DirectTransfer;
  peerName: string;
  direct: DirectTransfers;
}) {
  const live = t.status === 'active' || t.status === 'queued';
  const who = t.direction === 'in' ? `from ${peerName}` : `to ${peerName}`;
  let status: string;
  if (t.status === 'queued') status = 'Waiting…';
  else if (t.status === 'active') status = `${Math.round((t.transferred / t.size) * 100)}%`;
  else if (t.status === 'complete') status = t.direction === 'in' ? 'Received' : 'Sent';
  else status = t.error ?? (t.status === 'cancelled' ? 'Cancelled' : 'Failed');

  return (
    <li className="flex flex-col gap-1.5 text-sm" data-testid="direct-transfer">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={t.name}>
            {t.name}
          </p>
          <p className="text-xs text-ink-muted">
            {formatBytes(t.size)} · {who} ·{' '}
            <span className={t.status === 'failed' ? 'text-down' : ''}>{status}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {t.blob && (
            <IconButton
              label={`Save ${t.name}`}
              onClick={() => t.blob && saveBlob(t.blob, t.name)}
              className="size-9"
            >
              <DownloadIcon />
            </IconButton>
          )}
          <IconButton
            label={live ? `Cancel ${t.name}` : `Remove ${t.name} from the list`}
            onClick={() => (live ? direct.cancel(t.key) : direct.dismiss(t.key))}
            className="size-9"
          >
            <CloseIcon />
          </IconButton>
        </div>
      </div>
      {t.status === 'active' && (
        <ProgressBar value={t.transferred / t.size} label={`${t.name} ${who}`} />
      )}
    </li>
  );
}
