import { useEffect, useRef } from 'react';
import type { Participant } from '@confluence/shared';
import type { ConnectionQuality } from '../../lib/media/quality';
import { MicOffIcon } from './icons';

interface VideoTileProps {
  participant: Participant;
  stream: MediaStream | null;
  isSelf: boolean;
  speaking: boolean;
  /** Remote tiles only: how the peer connection is doing. */
  connection?: RTCPeerConnectionState | undefined;
  /** Remote tiles only: measured quality of the connected link. */
  quality?: ConnectionQuality | undefined;
  /** The browser refused to autoplay sound; the page offers a button. */
  onPlaybackBlocked?: () => void;
  /** Small filmstrip tile, shown beside a presentation. */
  compact?: boolean;
  /**
   * Show the avatar even if video is flowing: the presenter's video slot is
   * carrying their screen, which the stage already shows.
   */
  hideVideo?: boolean;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

const CONNECTION_TEXT: Partial<Record<RTCPeerConnectionState, string>> = {
  new: 'Connecting…',
  connecting: 'Connecting…',
  disconnected: 'Reconnecting…',
  failed: 'Reconnecting…',
};

export function VideoTile({
  participant,
  stream,
  isSelf,
  speaking,
  connection,
  quality,
  onPlaybackBlocked,
  compact = false,
  hideVideo = false,
}: VideoTileProps) {
  const video = useRef<HTMLVideoElement>(null);
  const { audio: audioOn, video: videoOn } = participant.media;

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    if (!stream) return;
    element.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'NotAllowedError') onPlaybackBlocked?.();
    });
  }, [stream, onPlaybackBlocked]);

  const showVideo = !hideVideo && videoOn && stream !== null && stream.getVideoTracks().length > 0;
  const status = isSelf ? undefined : connection ? CONNECTION_TEXT[connection] : 'Connecting…';

  return (
    <li
      aria-label={`${participant.displayName}${isSelf ? ' (you)' : ''}`}
      data-peer={participant.peerId}
      data-speaking={speaking || undefined}
      className={`relative aspect-video shrink-0 overflow-hidden rounded-2xl border bg-surface-sunken transition-shadow ${
        compact ? 'w-44 sm:w-52' : ''
      } ${speaking ? 'border-up shadow-[0_0_0_3px_var(--up)]' : 'border-edge'}`}
    >
      {/*
        Always mounted, even with the camera off: remote AUDIO plays through
        this element too, so hiding it must not unmount it. Your own tile is
        muted (no echo) and mirrored, as people expect a self-view to be.
      */}
      <video
        ref={video}
        autoPlay
        playsInline
        muted={isSelf}
        className={`absolute inset-0 size-full object-cover ${isSelf ? '-scale-x-100' : ''} ${
          showVideo ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {!showVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            aria-hidden="true"
            className={`flex items-center justify-center rounded-full bg-accent-soft font-semibold text-accent ${
              compact ? 'size-10 text-sm' : 'size-16 text-xl'
            }`}
          >
            {initials(participant.displayName)}
          </span>
        </div>
      )}

      {status && (
        <div className="absolute inset-x-0 top-3 flex justify-center">
          <span className="rounded-md bg-surface-raised/90 px-2 py-1 text-xs text-ink-muted">
            {status}
          </span>
        </div>
      )}

      <span className="absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-md bg-surface-raised/90 px-2 py-1 text-xs font-medium">
        {!audioOn && (
          <span role="img" aria-label="Microphone off" className="text-down">
            <MicOffIcon size={14} />
          </span>
        )}
        <span className="truncate">{participant.displayName}</span>
        {isSelf && <span className="text-ink-muted">(you)</span>}
        {!isSelf && quality && connection === 'connected' && <QualityBars quality={quality} />}
        {participant.role === 'OWNER' && (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
            Host
          </span>
        )}
      </span>
    </li>
  );
}

const QUALITY_TEXT: Record<ConnectionQuality, string> = {
  good: 'Connection: good',
  fair: 'Connection: fair',
  poor: 'Connection: poor',
};

/** Three bars, filled by quality: the familiar signal-strength shape. */
function QualityBars({ quality }: { quality: ConnectionQuality }) {
  const filled = quality === 'good' ? 3 : quality === 'fair' ? 2 : 1;
  const color = quality === 'good' ? 'bg-up' : quality === 'fair' ? 'bg-warn' : 'bg-down';
  return (
    <span
      role="img"
      aria-label={QUALITY_TEXT[quality]}
      title={QUALITY_TEXT[quality]}
      className="flex h-3 items-end gap-px"
    >
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={`w-[3px] rounded-sm ${bar <= filled ? color : 'bg-edge-strong'}`}
          style={{ height: `${bar * 4}px` }}
        />
      ))}
    </span>
  );
}
