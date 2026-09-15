import { useId, type ReactNode } from 'react';
import { IconButton } from '../ui';
import { CloseIcon } from './icons';

interface SidePanelProps {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  /** Chat manages its own scrolling (a log above a composer); others scroll here. */
  scroll?: boolean;
}

/**
 * The card that slides in beside the call: one shell for meeting details,
 * chat and files, so all three look and behave the same. A labelled region,
 * so assistive tech (and the tests) can find it by its title.
 */
export function SidePanel({ title, closeLabel, onClose, children, scroll = true }: SidePanelProps) {
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      className="flex h-full animate-[panel-in_180ms_ease-out] flex-col overflow-hidden rounded-2xl bg-surface-raised text-ink ring-1 ring-edge shadow-[0_4px_24px_rgba(0,0,0,0.25)]"
    >
      <header className="flex shrink-0 items-center justify-between py-3 pr-3 pl-6">
        <h2 id={heading} className="text-lg font-normal">
          {title}
        </h2>
        <IconButton label={closeLabel} onClick={onClose}>
          <CloseIcon size={20} />
        </IconButton>
      </header>
      <div
        className={`flex min-h-0 flex-1 flex-col gap-5 px-6 pb-6 ${scroll ? 'overflow-y-auto' : ''}`}
      >
        {children}
      </div>
    </section>
  );
}
