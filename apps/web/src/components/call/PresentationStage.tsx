import { useEffect, useRef } from 'react';
import type { ScreenSharer } from '@confluence/shared';
import { Button } from '../ui';
import { ScreenShareIcon } from './icons';

interface PresentationStageProps {
  sharer: ScreenSharer;
  isSelf: boolean;
  /** The presenter's stream; its video track is carrying their screen. */
  stream: MediaStream | null;
  onStop: () => void;
}

/**
 * The large area a presentation is shown in (spec: spotlight view).
 *
 * The presenter sees a notice instead of their own screen: rendering your
 * own capture back to you is a hall of mirrors when you share this tab.
 *
 * The stage's <video> is muted. The presenter's filmstrip tile still has its
 * own (hidden) video element playing the same stream's audio; a second
 * unmuted element would play every word twice.
 */
export function PresentationStage({ sharer, isSelf, stream, onStop }: PresentationStageProps) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = video.current;
    if (!element || element.srcObject === stream) return;
    element.srcObject = stream;
    if (stream) void element.play().catch(() => undefined);
  }, [stream]);

  if (isSelf) {
    return (
      <section
        aria-label="Your presentation"
        className="flex h-[min(56vh,56vw)] min-h-56 w-full flex-col items-center justify-center gap-4 rounded-2xl border border-edge bg-surface-sunken p-6 text-center"
      >
        <span className="flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ScreenShareIcon />
        </span>
        <div>
          <h2 className="text-lg font-semibold">You are presenting to everyone</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Everyone in the meeting can see the screen you chose.
          </p>
        </div>
        <Button variant="danger" onClick={onStop}>
          Stop presenting
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-label={`${sharer.displayName}'s presentation`}
      // Height-capped so the call controls stay on screen; object-contain
      // letterboxes the screen rather than cropping it.
      className="relative h-[min(56vh,56vw)] min-h-56 w-full overflow-hidden rounded-2xl border border-edge bg-black"
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 size-full object-contain"
      />
      <span className="absolute left-3 top-3 flex items-center gap-2 rounded-md bg-surface-raised/90 px-2 py-1 text-xs font-medium">
        <ScreenShareIcon />
        {sharer.displayName} is presenting
      </span>
    </section>
  );
}
