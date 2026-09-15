import { useEffect, useRef } from 'react';

/**
 * Single-key shortcuts in a call (spec Phase 8). Single keys rather than
 * chords: browsers reserve most Ctrl combinations, and the whiteboard's own
 * tool keys (P L A R O T E) are chosen not to overlap with these.
 *
 * Ignored while typing (inputs, text areas, editable content), with a
 * modifier held (those belong to the browser), and while a dialog is open.
 */
export const CALL_SHORTCUTS = [
  { key: 'M', action: 'Turn the microphone on or off' },
  { key: 'V', action: 'Turn the camera on or off' },
  { key: 'S', action: 'Present your screen, or stop' },
  { key: 'C', action: 'Open or close chat' },
  { key: 'F', action: 'Open or close files' },
  { key: 'B', action: 'Open or close the whiteboard' },
  { key: '?', action: 'Show these shortcuts' },
] as const;

export const BOARD_SHORTCUTS = [
  { key: 'P', action: 'Pen' },
  { key: 'L', action: 'Line' },
  { key: 'A', action: 'Arrow' },
  { key: 'R', action: 'Rectangle' },
  { key: 'O', action: 'Ellipse' },
  { key: 'T', action: 'Text' },
  { key: 'E', action: 'Eraser' },
  { key: 'Ctrl+Z', action: 'Undo' },
  { key: 'Ctrl+Shift+Z', action: 'Redo' },
] as const;

type Handlers = Record<'m' | 'v' | 's' | 'c' | 'f' | 'b' | '?', () => void>;

export function useCallShortcuts(handlers: Handlers): void {
  // Latest handlers without re-registering the listener on every render.
  const current = useRef(handlers);
  current.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('dialog[open]')) return;
      const key = e.key.toLowerCase();
      if (!(key in current.current)) return;
      e.preventDefault();
      current.current[key as keyof Handlers]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
