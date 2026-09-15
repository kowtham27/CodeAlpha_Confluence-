import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

type Placement = 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start' | 'top';

const PLACEMENT: Record<Placement, string> = {
  'bottom-end': 'right-0 top-full mt-2 origin-top-right',
  'bottom-start': 'left-0 top-full mt-2 origin-top-left',
  'top-end': 'right-0 bottom-full mb-3 origin-bottom-right',
  'top-start': 'left-0 bottom-full mb-3 origin-bottom-left',
  top: 'left-1/2 bottom-full mb-3 -translate-x-1/2 origin-bottom',
};

interface PopoverProps {
  /** Accessible name of the trigger button. */
  label: string;
  /** What the trigger shows. */
  button: ReactNode;
  buttonClassName: string;
  placement?: Placement;
  panelClassName?: string;
  /** Receives `close`, for items that should dismiss the popover. */
  children: (close: () => void) => ReactNode;
}

/**
 * A disclosure popover: a button that shows and hides a panel of actions.
 * Closes on Escape (returning focus to the button) and on any click outside.
 * Deliberately not an ARIA "menu": its content is ordinary buttons, links and
 * form controls, reached with Tab like everywhere else.
 */
export function Popover({
  label,
  button,
  buttonClassName,
  placement = 'bottom-end',
  panelClassName = 'w-72',
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={buttonClassName}
      >
        {button}
      </button>
      {open && (
        <div
          id={id}
          className={`absolute z-40 animate-[pop-in_140ms_ease-out] rounded-2xl border border-edge bg-surface-raised text-ink shadow-[0_8px_28px_rgba(0,0,0,0.16)] ${PLACEMENT[placement]} ${panelClassName}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
