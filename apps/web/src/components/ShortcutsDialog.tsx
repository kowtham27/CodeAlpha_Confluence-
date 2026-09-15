import { useEffect, useRef } from 'react';
import { BOARD_SHORTCUTS, CALL_SHORTCUTS } from '../hooks/useCallShortcuts';
import { Button } from './ui';

/**
 * The keyboard shortcut reference. A native <dialog> opened modally: the
 * browser traps focus inside it, Esc closes it, and focus returns to where
 * it was.
 */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="shortcuts-title"
      onClose={onClose}
      className="m-auto w-full max-w-md rounded-2xl border border-edge bg-surface-raised p-6 text-ink shadow-xl backdrop:bg-black/40"
    >
      <h2 id="shortcuts-title" className="text-base font-semibold">
        Keyboard shortcuts
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        They work anywhere in a call, except while typing.
      </p>
      <ShortcutTable title="In a call" rows={CALL_SHORTCUTS} />
      <ShortcutTable title="On the whiteboard" rows={BOARD_SHORTCUTS} />
      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={onClose} autoFocus>
          Close
        </Button>
      </div>
    </dialog>
  );
}

function ShortcutTable({
  title,
  rows,
}: {
  title: string;
  rows: readonly { key: string; action: string }[];
}) {
  return (
    <table className="mt-4 w-full text-sm">
      <caption className="mb-1 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-edge">
            <td className="py-1.5 pr-4">
              <kbd className="rounded border border-edge-strong bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
                {r.key}
              </kbd>
            </td>
            <td className="py-1.5">{r.action}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
