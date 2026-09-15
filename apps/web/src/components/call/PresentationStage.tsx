import { useEffect, useRef } from 'react';
import type { ScreenSharer } from '@confluence/shared';
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
        className="flex size-full min-h-56 flex-col items-center justify-center gap-5 rounded-xl bg-stage-raised p-6 text-center"
      >
        <span className="flex size-16 items-center justify-center rounded-full bg-stage-accent/15 text-stage-accent">
          <ScreenShareIcon />
        </span>
        <div>
          <h2 className="text-[22px] font-normal text-stage-ink">You are presenting to everyone</h2>
          <p className="mt-1.5 text-sm text-stage-muted">
            Everyone in the meeting can see the screen you chose.
          </p>
        </div>
        <button
          type="button"
          onClick={onStop}
          className="h-10 rounded-full bg-stage-accent px-6 text-sm font-medium text-stage transition-[filter] hover:brightness-110"
        >
          Stop presenting
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label={`${sharer.displayName}'s presentation`}
      // object-contain letterboxes the screen rather than cropping it.
      className="relative size-full min-h-56 overflow-hidden rounded-xl bg-black"
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 size-full object-contain"
      />
      <span className="absolute top-3 left-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-[13px] font-medium text-white">
        <ScreenShareIcon />
        {sharer.displayName} is presenting
      </span>
    </section>
  );
}
