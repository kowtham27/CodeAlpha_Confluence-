import { useEffect, useRef } from 'react';
import type { Participant } from '@confluence/shared';
import type { ConnectionQuality } from '../../lib/media/quality';
import { Avatar } from '../ui';
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
  /** Small filmstrip tile, shown beside a presentation or the whiteboard. */
  compact?: boolean;
  /**
   * Show the avatar even if video is flowing: the presenter's video slot is
   * carrying their screen, which the stage already shows.
   */
  hideVideo?: boolean;
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
      className={`relative isolate overflow-hidden rounded-xl bg-stage-raised ${
        compact ? 'aspect-video w-48 shrink-0 sm:w-56 lg:w-full' : 'size-full min-h-0'
      }`}
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
        className={`absolute inset-0 size-full object-cover transition-opacity duration-300 ${
          isSelf ? '-scale-x-100' : ''
        } ${showVideo ? 'opacity-100' : 'opacity-0'}`}
      />

      {!showVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Avatar
            name={participant.displayName}
            seed={participant.userId}
            className={
              compact
                ? 'size-12 text-lg'
                : // A percentage height would follow the tile's height, not its
                  // width, and squash the circle; square it off the width.
                  'aspect-square w-[clamp(3.5rem,22%,8.5rem)] text-[clamp(1.25rem,3.5vw,2.75rem)]'
            }
          />
        </div>
      )}

      {/* Legibility for the name over bright video. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/55 to-transparent" />

      {status && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white">
            {status}
          </span>
        </div>
      )}

      {!isSelf && quality && connection === 'connected' && (
        <span className="absolute top-2.5 left-2.5 flex rounded-full bg-black/45 p-1.5">
          <QualityBars quality={quality} />
        </span>
      )}

      {!audioOn && (
        <span
          role="img"
          aria-label="Microphone off"
          className="absolute top-2.5 right-2.5 flex size-7 items-center justify-center rounded-full bg-black/55 text-white"
        >
          <MicOffIcon size={15} />
        </span>
      )}

      <span className="absolute bottom-2.5 left-3 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 text-[13px] font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
        <span className="truncate">{participant.displayName}</span>
        {isSelf && <span className="shrink-0 font-normal">(you)</span>}
        {participant.role === 'OWNER' && (
          <span className="shrink-0 rounded-full bg-black/55 px-2 py-px text-[11px] font-medium [text-shadow:none]">
            Host
          </span>
        )}
      </span>

      {/* The speaking ring sits above the video, inside the tile's corners. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 rounded-xl ring-[3px] ring-stage-accent ring-inset transition-opacity duration-150 ${
          speaking ? 'opacity-100' : 'opacity-0'
        }`}
      />
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
  const color =
    quality === 'good' ? 'bg-[#81c995]' : quality === 'fair' ? 'bg-[#fdd663]' : 'bg-[#f28b82]';
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
          className={`w-[3px] rounded-sm ${bar <= filled ? color : 'bg-white/30'}`}
          style={{ height: `${bar * 4}px` }}
        />
      ))}
    </span>
  );
}
